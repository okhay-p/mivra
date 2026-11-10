import { expect, test, type Page } from "../fixtures.js";

/** Imports a vault through the API, named so tests sharing a worker's database don't collide. */
async function importVault(page: Page, files: { path: string; text: string }[], { distil = true } = {}) {
  if (!distil) files = files.map((f) => ({ ...f, text: `${f.text} slowdistil` }));
  await page.goto("/");
  const token = await page.locator('meta[name="mivra-token"]').getAttribute("content");
  const headers = { Authorization: `Bearer ${token}` };
  const name = `Graph vault ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`;
  const res = await page.request.post("/api/imports", { headers, data: { name, files } });
  expect(res.status()).toBe(201);
  const id = ((await res.json()) as { import: { id: string } }).import.id;
  // The scripted model answers at once, so distilling thousands of notes would keep the server busy for a minute.
  // Notes saying "slowdistil" hold its first call instead, until it's cancelled here.
  if (!distil) await page.request.delete(`/api/imports/${id}/distillation`, { headers });
  return { id, name, headers };
}

async function openGraph(page: Page, name: string) {
  await page.reload();
  await page.getByRole("button", { name: "Imported notes" }).click();
  const panel = page.getByRole("dialog", { name: "Imported notes" });
  await panel.getByRole("listitem", { name }).getByRole("button", { name: "Graph" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("heading", { name: "Notes graph" })).toBeFocused();
  return page.getByTestId("notes-graph");
}

async function pick(page: Page, filter: string, option: string | RegExp) {
  await page.getByRole("toolbar", { name: "Graph filters" }).getByRole("combobox", { name: filter }).click();
  await page.getByRole("option", { name: option }).click();
}

test.describe("notes graph", () => {
  test.setTimeout(120_000);

  test("opens an import's graph, filters it, and opens a note to read, by mouse and keyboard", async ({ page }) => {
    const { name } = await importVault(page, [
      { path: "CS/Recursion.md", text: "---\ntags: [cs]\n---\nA function that calls itself. See [[Stack]] and [[Base case]]." },
      { path: "CS/Stack.md", text: "#cs Last in, first out." },
      { path: "Cooking/Bread.md", text: "#food Flour, water, salt." },
      { path: "Cooking/Soup.md", text: "#food Stock and [[Bread]]." },
    ]);
    const graph = await openGraph(page, name);
    const status = graph.getByTestId("notes-graph-status");
    await expect(status).toContainText(/^Whole graph: 4 notes, 2 tags, \d+ concepts?, 1 unresolved link, of 4 notes\.$/);
    const nodes = graph.getByTestId("notes-graph-node");
    await expect(graph.locator('[data-testid="notes-graph-node"][data-kind="note"]')).toHaveCount(4);
    await expect(graph.getByRole("button", { name: "Base case, unresolved link, no such note" })).toBeVisible();
    await expect(graph.getByRole("button", { name: "#cs, tag on 2 notes" })).toBeVisible();
    // Every label sits inside the drawing.
    const canvas = (await graph.getByTestId("notes-graph-canvas").boundingBox())!;
    for (const label of await graph.getByTestId("notes-graph-label").all()) {
      const box = (await label.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(canvas.x - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
    }

    await pick(page, "Tag", "#food (2)");
    await expect(status).toContainText(/^Whole graph: 2 notes, 1 tag, .*of 2 matching notes \(4 notes in all\)\.$/);
    await expect(graph.getByRole("button", { name: /^Recursion, note/ })).toHaveCount(0);
    await pick(page, "Tag", "All tags");
    await pick(page, "Folder", "CS (2)");
    await expect(status).toContainText(/^Whole graph: 2 notes, 1 tag, .*of 2 matching notes/);

    // Mouse: clicking a note opens it to read.
    await graph.getByRole("button", { name: /^Recursion, note in CS\/Recursion\.md/ }).click();
    const reader = page.getByRole("dialog", { name: "Recursion" });
    await expect(reader.getByTestId("note-body")).toContainText("A function that calls itself.");
    await expect(reader.getByText("CS/Recursion.md · read-only")).toBeVisible();
    await expect(reader.getByText("#cs")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();

    // Keyboard: the drawing is one tab stop, arrow keys move between nodes, and Enter opens a note.
    const recursion = graph.getByRole("button", { name: /^Recursion, note/ });
    await expect(recursion).toBeFocused();
    await expect(recursion).toHaveAttribute("aria-pressed", "true");
    await expect(graph.locator('[data-testid="notes-graph-node"][tabindex="0"]')).toHaveCount(1);
    await expect(graph.getByTestId("notes-graph-neighbours")).toContainText(/^Recursion connects to .*Stack/);
    const before = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    let moved = false;
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) {
      await page.keyboard.press(key);
      if ((await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) !== before) {
        moved = true;
        break;
      }
    }
    expect(moved).toBe(true);
    await expect(nodes.and(page.locator(":focus"))).toHaveCount(1);
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(nodes.and(page.locator(":focus"))).toHaveCount(1);
    const stack = graph.getByRole("button", { name: /^Stack, note/ });
    await stack.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Stack" }).getByTestId("note-body")).toContainText("Last in, first out.");
  });

  test("stays responsive on a 2,000-note vault, opening on the local graph", async ({ page }) => {
    const files = Array.from({ length: 2_000 }, (_, i) => ({
      path: `Folder ${i % 20}/Note ${i}.md`,
      text: `#topic${i % 40} About note ${i}. See [[Note ${(i + 1) % 2_000}]] and [[Note ${(i * 7) % 2_000}]].`,
    }));
    const { name } = await importVault(page, files, { distil: false });
    const started = Date.now();
    const graph = await openGraph(page, name);
    const status = graph.getByTestId("notes-graph-status");
    await expect(status).toContainText(/^Around Note \d+, within 2 hops: .* of 2,000 notes\./, { timeout: 15_000 });
    const notes = graph.locator('[data-testid="notes-graph-node"][data-kind="note"]');
    // Laid out in a worker, so the nodes come a moment after the status.
    await expect(notes.first()).toBeVisible();
    expect(await notes.count()).toBeLessThanOrEqual(500);
    expect(await notes.count()).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(20_000);

    // The whole graph isn't offered past 500 notes.
    await page.getByRole("toolbar", { name: "Graph filters" }).getByRole("combobox", { name: "Show" }).click();
    await expect(page.getByRole("option", { name: /^Whole graph \(over 500 notes\)/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // Finding a far note recentres the graph on it, and the drawing still answers quickly.
    await graph.getByRole("button", { name: "Find a note" }).click();
    await page.getByRole("combobox", { name: "Find a note by title or path" }).fill("Note 1234");
    await page.getByRole("option", { name: /^Note 1234/ }).click();
    await expect(status).toContainText(/^Around Note 1234, within 2 hops/);
    const target = graph.getByRole("button", { name: /^Note 1234, note/ });
    await expect(target).toHaveAttribute("aria-pressed", "true");
    const clicked = Date.now();
    await target.click();
    await expect(page.getByRole("dialog", { name: "Note 1234" }).getByTestId("note-body")).toContainText("About note 1234.");
    expect(Date.now() - clicked).toBeLessThan(5_000);
    await page.keyboard.press("Escape");

    await pick(page, "Reach", "1 hop");
    await expect(status).toContainText(/^Around Note 1234, within 1 hop/);
    await pick(page, "Folder", /^Folder 3 \(/);
    await expect(status).toContainText(/of 100 matching notes \(2,000 notes in all\)/);
  });
});
