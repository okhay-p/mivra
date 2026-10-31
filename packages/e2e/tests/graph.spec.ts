import { expect, test, type Page } from "@playwright/test";

/** Runs a graph script. The timestamp names the session uniquely, since tests share a database. */
async function showGraph(page: Page, script: string) {
  await page.goto("/");
  // On a narrow screen the sidebar's actions are behind its toggle.
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole("main").getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.locator('[data-mobile="true"]').getByRole("button", { name: "New session" }).first().click();
  } else {
    await page.getByRole("button", { name: "New session" }).first().click();
  }
  await page.getByRole("textbox", { name: "Message" }).fill(`${script} ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  const graph = page.getByRole("region", { name: /graph$/i });
  await expect(graph).toBeVisible();
  return graph;
}

/** Where every node's centre is within the drawing. The chat may scroll the whole card while a reply arrives. */
const centres = (page: Page) =>
  page.getByTestId("graph-canvas").evaluate((canvas) => {
    const origin = canvas.getBoundingClientRect();
    return [...canvas.querySelectorAll('[data-testid="graph-node"]')].map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2 - origin.x, y: box.y + box.height / 2 - origin.y };
    });
  });

test.describe("graph", () => {
  test("renders every node and edge, and stepping changes state without moving anything", async ({ page }) => {
    const graph = await showGraph(page, "graphweighted");
    await expect(graph.getByTestId("graph-node")).toHaveCount(5);
    await expect(graph.getByTestId("graph-edge")).toHaveCount(7);
    await expect(graph.getByTestId("graph-arrow")).toHaveCount(7);
    await expect(graph.getByTestId("graph-edge-label")).toHaveCount(7);
    await expect(graph.getByTestId("graph-edge-label").first()).toHaveText("4");
    await expect(graph.locator('[data-node="a"] .katex')).toBeVisible();

    const before = await centres(page);
    const a = graph.locator('[data-node="a"]');
    await expect(a).toHaveAttribute("data-tone", "active");
    await expect(graph.locator('[data-testid="graph-edge"][data-tone]')).toHaveCount(0);

    await graph.getByRole("button", { name: "Next" }).click();
    await expect(a).toHaveAttribute("data-tone", "done");
    await expect(graph.locator('[data-testid="graph-edge"][data-tone]')).toHaveCount(2);
    expect(await centres(page)).toEqual(before);

    await graph.getByRole("button", { name: "Next" }).click();
    // Not carried over: this step doesn't mention a.
    await expect(a).not.toHaveAttribute("data-tone");
    expect(await centres(page)).toEqual(before);
    await expect(graph.getByTestId("graph-status")).toContainText("is done");
  });

  test("a tree is laid out in levels, with children in edge order", async ({ page }) => {
    const graph = await showGraph(page, "graphtree");
    await expect(graph.getByTestId("graph-canvas")).toHaveAttribute("data-layout", "tree");
    const at = async (id: string) => (await graph.locator(`[data-node="${id}"]`).boundingBox())!;
    const [root, left, right, leaf, loneRight, loneLeft] = await Promise.all([at("8"), at("3"), at("10"), at("6"), at("14"), at("13")]);
    expect(left.y).toBeGreaterThan(root.y);
    expect(left.y).toBe(right.y);
    expect(left.x).toBeLessThan(right.x);
    expect(leaf.y).toBeGreaterThan(left.y);
    // A lone child keeps its side: 14 is right of its parent 10, and 13 is left of its parent 14.
    expect(loneRight.x).toBeGreaterThan(right.x);
    expect(loneLeft.x).toBeLessThan(loneRight.x);
  });

  test("self-loops and parallel edges are all drawn apart", async ({ page }) => {
    const graph = await showGraph(page, "graphloop");
    await expect(graph.getByTestId("graph-node")).toHaveCount(3);
    await expect(graph.getByTestId("graph-edge")).toHaveCount(7);
    await expect(graph.getByTestId("graph-arrow")).toHaveCount(0);
    const paths = await graph.locator('[data-testid="graph-edge"] path').evaluateAll((all) => all.map((path) => path.getAttribute("d")));
    expect(new Set(paths).size).toBe(7);
    const labels = await graph.getByTestId("graph-edge-label").evaluateAll((all) => all.map((label) => label.getBoundingClientRect().y));
    expect(new Set(labels).size).toBeGreaterThan(1);
    await graph.getByRole("button", { name: "Next" }).click();
    await expect(graph.locator('[data-testid="graph-edge"][data-tone="done"]')).toHaveCount(1);
  });

  for (const script of ["graphweighted", "graphlimit"]) {
    test(`${script} doesn't overflow the page at 320px`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      const graph = await showGraph(page, script);
      await expect(graph.getByTestId("graph-canvas")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = graph.getByTestId("graph-scroll");
      const fit = await box.evaluate((e) => ({ scrolls: e.scrollWidth > e.clientWidth, left: e.scrollLeft, right: e.getBoundingClientRect().right }));
      expect(fit.right).toBeLessThanOrEqual(320);
      // The small graph shrinks to fit; the largest one can't and scrolls in its own box instead.
      expect(fit.scrolls).toBe(script === "graphlimit");
      if (fit.scrolls) expect(fit.left).toBeGreaterThan(0);
      const sizes = await graph.locator('[data-testid="graph-node"], [data-testid="graph-edge-label"]').evaluateAll((labels) => labels.map((label) => parseFloat(getComputedStyle(label).fontSize)));
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10.99);
    });
  }

  test("a deep skewed tree scrolls in its box from the root, legibly, and the keyboard scrolls it", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const graph = await showGraph(page, "graphskew");
    const box = graph.getByTestId("graph-scroll");
    await expect(graph.getByTestId("graph-canvas")).toHaveAttribute("data-layout", "tree");
    await expect(box).toHaveAttribute("tabindex", "0");
    await expect(graph.getByRole("group", { name: "Scrollable graph drawing" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const size = await graph.locator('[data-node="59"]').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    expect(size).toBeGreaterThanOrEqual(10.99);
    const scroll = () => box.evaluate((e) => ({ left: e.scrollLeft, top: e.scrollTop, max: e.scrollWidth - e.clientWidth }));
    const opening = await scroll();
    expect(opening.top).toBe(0);
    expect(opening.max).toBeGreaterThan(0);
    const inBox = await graph.locator('[data-node="0"]').evaluate((node) => {
      const { left, right } = node.getBoundingClientRect();
      const outer = node.closest('[data-testid="graph-scroll"]')!.getBoundingClientRect();
      return left >= outer.left && right <= outer.right;
    });
    expect(inBox).toBe(true);

    await box.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await scroll()).left).toBeGreaterThan(opening.left);
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await scroll()).top).toBeGreaterThan(0);
    await expect(graph.getByTestId("graph-status")).toContainText("Step 1 of 2");

    // Outside the box the arrow keys still step.
    await graph.focus();
    await page.keyboard.press("ArrowRight");
    await expect(graph.getByTestId("graph-status")).toContainText("Step 2 of 2");
  });

  test("a graph that fits is not a tab stop, and only its drawing is hidden from screen readers", async ({ page }) => {
    const graph = await showGraph(page, "graphweighted");
    const box = graph.getByTestId("graph-scroll");
    await expect(box).not.toHaveAttribute("tabindex");
    await expect(box).not.toHaveAttribute("aria-hidden");
    await expect(graph.getByTestId("graph-canvas")).toHaveAttribute("aria-hidden", "true");
  });
});
