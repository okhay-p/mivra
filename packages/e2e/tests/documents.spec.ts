import { expect, test, type Page } from "../fixtures.js";
import { makePdf } from "../../server/test/support/files.js";

async function startSession(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

const attach = (page: Page, name: string, buffer: Buffer) => page.getByTestId("document-input").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
// The harness starts each extraction's worker through tsx, which takes seconds on a busy machine.
const READ = { timeout: 45_000 };
const chips = (page: Page) => page.getByRole("list", { name: "Attached documents" });

test.describe("uploaded documents", () => {
  test.setTimeout(150_000);

  test("an attached PDF reaches the model, and stops when removed", async ({ page }) => {
    // Letters only, since the harness and search both read it as one word.
    const word = `zeta${Date.now().toString(36).replace(/\d/g, "q")}`;
    await startSession(page);
    await attach(page, "Discrete notes.pdf", makePdf([["Opening page with nothing special on it at all."], [`The word ${word} appears on the second page.`]]));
    await expect(chips(page).getByText("Discrete notes.pdf")).toBeVisible(READ);
    await expect(chips(page).getByText("2 pages")).toBeVisible();
    await expect(page.getByText(/images and diagrams aren't/)).toBeVisible();

    await send(page, `excerpt ${word}`);
    await expect(page.getByText(`Excerpt reached me: ${word}.`)).toBeVisible();

    await chips(page).getByRole("button", { name: "Remove Discrete notes.pdf" }).click();
    await expect(chips(page)).toHaveCount(0);
    await send(page, `excerpt ${word} again`);
    await expect(page.getByText("No excerpt reached me.")).toBeVisible();
  });

  test("a chip moves to its sent message, survives reload, and can still be removed", async ({ page }) => {
    const title = `attached ${Date.now()}`;
    await startSession(page);
    await attach(page, "Sent notes.pdf", makePdf([["The durable attachment has useful text to read."]]));
    const composer = page.locator("form");
    await expect(composer.getByRole("list", { name: "Attached documents" }).getByText("Sent notes.pdf", { exact: true })).toBeVisible(READ);
    await send(page, title);
    await expect(page.getByText(/The server says/)).toBeVisible();
    await expect(composer.getByText("Sent notes.pdf")).toHaveCount(0);
    const message = page.getByTestId("transcript").locator("[data-message-id]").filter({ has: page.getByText(title, { exact: true }) });
    await expect(message.getByText("Sent notes.pdf")).toBeVisible();
    await page.getByRole("button", { name: "New session" }).first().click();
    await expect(chips(page)).toHaveCount(0);
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(chips(page).getByText("Sent notes.pdf")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(message.getByText("Sent notes.pdf")).toBeVisible();
    await expect(composer.getByText("Sent notes.pdf")).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await message.getByRole("button", { name: "Remove Sent notes.pdf" }).click();
    await expect(chips(page)).toHaveCount(0);
  });

  test("a long filename stays inside the error at 320px", async ({ page }) => {
    // The button that starts a session lives in the sidebar, which collapses at this width.
    await startSession(page);
    await page.setViewportSize({ width: 320, height: 640 });
    // Refused in the browser for its size, with its name in the message.
    await attach(page, `${"x".repeat(180)}.pdf`, Buffer.alloc(25 * 1024 * 1024 + 1));
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("over the 25 MB limit");
    const { scroll, client } = await alert.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);
    expect((await alert.boundingBox())!.x + client).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });

  test("explains why a file was refused", async ({ page }) => {
    await startSession(page);
    await attach(page, "fake.pdf", Buffer.from("this is not a pdf at all"));
    await expect(page.getByRole("alert")).toHaveText(/Only PDF and PowerPoint/, READ);
    await attach(page, "scan.pdf", makePdf([[], []]));
    await expect(page.getByRole("alert")).toHaveText(/probably scanned/, READ);
    await expect(chips(page)).toHaveCount(0);
  });
});
