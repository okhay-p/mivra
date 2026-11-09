import { expect, test, type Page } from "../fixtures.js";

const entry = (page: Page, title: string) =>
  page.locator('[data-slot="sidebar-content"] [data-slot="sidebar-menu-item"]').filter({ has: page.getByRole("button", { name: title, exact: true }) });

/** Opens an entry's menu and chooses Rename, which swaps its title for a field. */
async function startRename(page: Page, title: string) {
  const item = entry(page, title);
  await item.hover();
  await item.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.locator('[data-slot="sidebar-content"]').getByRole("textbox", { name: "Title" });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(title);
  return field;
}

const authHeaders = async (page: Page) => ({ Authorization: `Bearer ${await page.locator('meta[name="mivra-token"]').getAttribute("content")}` });

test("renames the open chat from the sidebar: Esc cancels, Enter saves, and the header follows at once", async ({ page }) => {
  const prompt = `rename me ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/The server says/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(prompt);

  // Esc leaves the title as it was and gives focus back to the entry.
  let field = await startRename(page, prompt);
  await field.fill("Not this one");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(entry(page, prompt).getByRole("button", { name: prompt, exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(prompt);

  // Enter saves the trimmed title, in the sidebar and the header, and it survives a reload.
  const renamed = `Limits, properly ${Date.now()}`;
  field = await startRename(page, prompt);
  await field.fill(`  ${renamed}  `);
  await field.press("Enter");
  await expect(field).toHaveCount(0);
  await expect(entry(page, renamed)).toHaveCount(1);
  await expect(entry(page, prompt)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(renamed);
  await expect(entry(page, renamed).getByRole("button", { name: renamed, exact: true })).toHaveAttribute("data-active", "true");

  // An empty title saves nothing.
  field = await startRename(page, renamed);
  await field.fill("   ");
  await field.press("Enter");
  await expect(entry(page, renamed)).toHaveCount(1);

  await page.reload();
  await expect(entry(page, renamed)).toHaveCount(1);
  await entry(page, renamed).getByRole("button", { name: renamed, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(renamed);
});

test("renames a course from the sidebar, keeping it a course", async ({ page, request }) => {
  await page.goto("/");
  const goal = `Rename me course ${Date.now()}`;
  const created = await request.post("/api/courses", { headers: await authHeaders(page), data: { goal } });
  expect(created.status()).toBe(201);
  await page.reload();

  const renamed = `Real analysis ${Date.now()}`;
  const field = await startRename(page, goal);
  await field.fill(renamed);
  await field.press("Enter");
  await expect(entry(page, renamed).locator('[aria-label="Course"]')).toBeVisible();
  await expect(entry(page, goal)).toHaveCount(0);

  await page.reload();
  await expect(entry(page, renamed).locator('[aria-label="Course"]')).toBeVisible();
});
