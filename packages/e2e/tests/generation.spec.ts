import { expect, test, type Page } from "@playwright/test";

async function start(page: Page, prompt: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function send(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
type State = { runs: { sessionId: string; status: string }[]; modelAborts: number; controlledStarts: number; pendingMemories: number };

test("Stop cancels the model during thinking and a partial tool stream, preserves text, and frees the session", async ({ page, request }) => {
  for (const script of ["cancelthinking", "cancelstream"]) {
    const prompt = script + Date.now();
    const before = await (await request.get("/e2e/state")).json() as State;
    await start(page, prompt);
    if (script === "cancelstream") await expect(page.getByText("Here is the part already explained.")).toBeVisible();
    await expect.poll(async () => ((await (await request.get("/e2e/state")).json()) as State).controlledStarts).toBeGreaterThan(before.controlledStarts);
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
    await expect.poll(async () => {
      const state = await (await request.get("/e2e/state")).json() as State;
      return { status: state.runs.at(-1)?.status, aborted: state.modelAborts > before.modelAborts, pending: state.pendingMemories };
    }).toEqual({ status: "cancelled", aborted: true, pending: 0 });
    await expect(page.getByText(/failed|couldn.t stop|already in progress/i)).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Check/ })).toHaveCount(0);
    await send(page, "hello again");
    await expect(page.getByText(/The server says/)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: prompt, exact: true }).click();
    if (script === "cancelstream") await expect(page.getByText("Here is the part already explained.")).toBeVisible();
    await expect(page.getByRole("region", { name: /^Check/ })).toHaveCount(0);
  }
});

test("thinking is opt-in, streams while open, persists on reload, and is absent without reasoning", async ({ page }) => {
  const prompt = "liveThinking" + Date.now();
  await start(page, prompt);
  const toggle = page.getByRole("button", { name: /^Thinking/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Considering", { exact: true })).toBeHidden();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator('[id="' + await toggle.getAttribute("aria-controls") + '"]');
  await expect(panel).toContainText("Considering");
  await expect(panel).toContainText("aaa");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByText("The explanation is ready.")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByRole("button", { name: prompt, exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.locator('[id="' + await toggle.getAttribute("aria-controls") + '"]')).toContainText("aaa");
  await expect(page.getByText("PRIVATE-REASONING")).toHaveCount(0);
  await start(page, "ordinary" + Date.now());
  await expect(page.getByText(/The server says/)).toBeVisible();
  await expect(toggle).toHaveCount(0);
});
