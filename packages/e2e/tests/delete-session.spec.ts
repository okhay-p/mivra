import { expect, test, type Page } from "../fixtures.js";

type State = { runs: { sessionId: string; status: string }[]; modelAborts: number; pendingMemories: number };

const entry = (page: Page, title: string) =>
  page.locator('[data-slot="sidebar-content"] [data-slot="sidebar-menu-item"]').filter({ has: page.getByRole("button", { name: title }) });

/** Opens an entry's menu and chooses Delete, which asks first. */
async function askToDelete(page: Page, title: string) {
  const item = entry(page, title);
  await item.hover();
  await item.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`Delete “${title}”?`);
  return dialog;
}

const authHeaders = async (page: Page) => ({ Authorization: `Bearer ${await page.locator('meta[name="mivra-token"]').getAttribute("content")}` });

test("deletes the open chat mid-reply after confirming, stopping the reply and going back to the start screen", async ({ page, request }) => {
  // The session takes its first message as its title once that reply finishes.
  const prompt = `delete mid-reply ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/The server says/)).toBeVisible();
  await expect(entry(page, prompt)).toHaveCount(1);
  await page.getByRole("textbox", { name: "Message" }).fill("cancelstream");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Here is the part already explained.")).toBeVisible();
  const before = (await (await request.get("/e2e/state")).json()) as State;
  const sessionId = before.runs.at(-1)!.sessionId;

  // Cancel keeps it.
  await (await askToDelete(page, prompt)).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(entry(page, prompt)).toHaveCount(1);

  await (await askToDelete(page, prompt)).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(entry(page, prompt)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Or just chat" })).toBeVisible();

  // The reply was stopped, and nothing of the session is left.
  await expect
    .poll(async () => {
      const state = (await (await request.get("/e2e/state")).json()) as State;
      return { aborted: state.modelAborts > before.modelAborts, runs: state.runs.filter((r) => r.sessionId === sessionId).length, pending: state.pendingMemories };
    })
    .toEqual({ aborted: true, runs: 0, pending: 0 });
  expect((await request.get(`/api/sessions/${sessionId}/messages`, { headers: await authHeaders(page) })).status()).toBe(404);
  await page.reload();
  await expect(page.getByRole("button", { name: "Or just chat" })).toBeVisible();
  await expect(entry(page, prompt)).toHaveCount(0);
});

test("deletes a course that isn't open, leaving the open chat as it is", async ({ page, request }) => {
  await page.goto("/");
  const goal = `Delete me course ${Date.now()}`;
  const created = await request.post("/api/courses", { headers: await authHeaders(page), data: { goal } });
  expect(created.status()).toBe(201);
  await page.reload();

  const prompt = `stay open ${Date.now()}`;
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/The server says/)).toBeVisible();

  const dialog = await askToDelete(page, goal);
  await expect(dialog).toContainText("lessons");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(entry(page, goal)).toHaveCount(0);
  await expect(entry(page, prompt).getByRole("button", { name: prompt })).toHaveAttribute("data-active", "true");
  await expect(page.getByText(/The server says/)).toBeVisible();
});
