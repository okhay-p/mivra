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
  // The enlarged maths fixture can take longer to commit in Firefox/WebKit under the full suite.
  await expect(graph).toBeVisible({ timeout: 15_000 });
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

/** Every pair of labels whose boxes touch, naming them. Anything wider than its box is checked to be clipped to it. */
const labelClashes = (page: Page) =>
  page.getByTestId("graph-canvas").evaluate((canvas) => {
    const boxes = [...canvas.querySelectorAll<HTMLElement>('[data-testid="graph-node"], [data-testid="graph-edge-label"]')].map((label, i) => {
      const clip = label.querySelector<HTMLElement>("[data-label-clip]")!;
      return { name: clip.dataset.labelClip ?? String(i), box: label.getBoundingClientRect(), clipped: getComputedStyle(clip).overflow === "hidden" };
    });
    const clashes: string[] = [];
    for (const [i, a] of boxes.entries()) {
      if (!a.clipped) clashes.push(`${a.name} isn't clipped`);
      for (const b of boxes.slice(i + 1)) {
        if (a.box.left < b.box.right && b.box.left < a.box.right && a.box.top < b.box.bottom && b.box.top < a.box.bottom) clashes.push(`${a.name} and ${b.name}`);
      }
    }
    return clashes;
  });
const fontsLoaded = (page: Page) => page.evaluate(async () => void (await document.fonts.ready));

/** Allow under 0.05px: Firefox quantizes boxes to 1/60px when the surrounding chat scrolls. */
function expectSamePlaces(after: { x: number; y: number }[], before: { x: number; y: number }[]) {
  expect(after).toHaveLength(before.length);
  after.forEach((place, i) => {
    expect(place.x).toBeCloseTo(before[i]!.x, 1);
    expect(place.y).toBeCloseTo(before[i]!.y, 1);
  });
}

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
    expectSamePlaces(await centres(page), before);

    await graph.getByRole("button", { name: "Next" }).click();
    // Not carried over: this step doesn't mention a.
    await expect(a).not.toHaveAttribute("data-tone");
    expectSamePlaces(await centres(page), before);
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

  for (const width of [1100, 320]) {
    test(`a BST reads in sorted order across the page at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const graph = await showGraph(page, "graphbst");
      await expect(graph.getByTestId("graph-canvas")).toHaveAttribute("data-layout", "tree");
      const boxes = await Promise.all(["5", "6", "7", "8", "10", "20"].map(async (id) => (await graph.locator(`[data-node="${id}"]`).boundingBox())!));
      boxes.slice(1).forEach((box, i) => expect(box.x).toBeGreaterThan(boxes[i]!.x));
      expect(await graph.getByTestId("graph-scroll").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    });
  }

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

  for (const width of [1100, 320]) {
    for (const script of ["graphcutkatex", "graphcutcjk", "graphcutgeneral", "graphcutcjkgeneral", "graphcuttall"]) {
      test(`${script}: no labels overlap at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await showGraph(page, script);
        await fontsLoaded(page);
        expect(await labelClashes(page)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }

    test(`clipped vertices with shared prefixes have stable drawing keys at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const graph = await showGraph(page, "graphcutgeneral");
      await fontsLoaded(page);
      const list = graph.getByTestId("graph-overflow");
      const before = await centres(page);
      const checkKeys = async () => {
        for (const [i, id] of ["a", "b", "c", "d"].entries()) {
          const key = `[${i + 1}]`;
          const node = graph.locator(`[data-node="${id}"]`);
          await expect(node.locator("[data-node-key]")).toHaveText(key);
          const row = list.getByTestId("step-scroll").filter({ hasText: `Node ${key}:` });
          await expect(row).toHaveCount(1);
          await expect(row.locator(".katex-html")).toContainText(`WWWWWWWWWWWWW${String.fromCharCode(65 + i)}W`);
          await expect(row.locator('span[aria-hidden="true"]').first()).toBeAttached();
          // The key stays inside the same box as the vertex, even when its label is taller or wider.
          expect(await node.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const key = element.querySelector("[data-node-key]")!.getBoundingClientRect();
            return key.left >= box.left && key.right <= box.right && key.top >= box.top && key.bottom <= box.bottom;
          })).toBe(true);
        }
        for (const ends of ["[1] – [2]", "[2] – [3]", "[3] – [4]", "[4] – [1]"]) {
          await expect(list.getByText(`Edge ${ends}:`, { exact: true })).toHaveCount(1);
        }
      };
      await checkKeys();
      await expect(graph.getByTestId("graph-canvas")).toHaveAttribute("aria-hidden", "true");
      await graph.getByRole("button", { name: "Next" }).click();
      await checkKeys();
      expectSamePlaces(await centres(page), before);
      expect(await labelClashes(page)).toEqual([]);
    });

    test(`labels cut short are marked, and listed in full, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const graph = await showGraph(page, "graphcutkatex");
      await fontsLoaded(page);
      const list = graph.getByTestId("graph-overflow");
      await expect(list).toBeVisible();
      await expect(graph.getByTestId("graph-canvas").getByTestId("graph-label-cut")).toHaveCount(13);
      // One row per label, and each says which: an edge by what it joins, as KaTeX's text is doubled in its MathML.
      await expect(list.getByTestId("step-scroll")).toHaveCount(13);
      await expect(list.getByText("Edge", { exact: false })).toHaveCount(6);
      await expect(list.getByTestId("step-scroll").first().locator(".katex-html")).toContainText("WWWWWWWWWWWWWAW");
      // It isn't read twice: only what can't be hidden, a scrolling box's name, is left for screen readers.
      expect(await list.locator('[data-testid="step-scroll"] > span[aria-hidden="true"]').count()).toBe(13);

      const before = await centres(page);
      await graph.getByRole("button", { name: "Next" }).click();
      await expect(graph.locator('[data-node="a"]')).toHaveAttribute("data-tone", "active");
      expectSamePlaces(await centres(page), before);
      await expect(list.getByTestId("step-scroll")).toHaveCount(13);
      expect(await labelClashes(page)).toEqual([]);
    });
  }

  test("a label's whole text can be reached by keyboard when it's too wide for its row", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const graph = await showGraph(page, "graphcuttall");
    await fontsLoaded(page);
    const row = graph.getByTestId("graph-overflow").getByRole("group").first();
    await expect(row).toHaveAttribute("tabindex", "0");
    await expect(row).toContainText("WWWWWWWWWW");
    await row.focus();
    const left = () => row.evaluate((e) => e.scrollLeft);
    await page.keyboard.press("ArrowRight");
    await expect.poll(left).toBeGreaterThan(0);
  });

  test("a label taller than its node is cut short too", async ({ page }) => {
    const graph = await showGraph(page, "graphcuttall");
    await fontsLoaded(page);
    await expect(graph.locator('[data-node="a"] [data-truncated]')).toBeVisible();
    await expect(graph.locator('[data-node="b"] [data-truncated]')).toHaveCount(0);
  });

  for (const width of [1100, 320]) {
    test(`everyday labels and formulas aren't cut short at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const graph = await showGraph(page, "graphshort");
      await fontsLoaded(page);
      await expect(graph.getByTestId("graph-node")).toHaveCount(22);
      await page.waitForTimeout(200);
      expect(await graph.locator("[data-truncated]").evaluateAll((all) => all.map((e) => `${e.getAttribute("data-label-clip")}: ${e.textContent}`))).toEqual([]);
      await expect(graph.getByTestId("graph-overflow")).toHaveCount(0);
      await expect(graph.getByTestId("graph-edge-label")).toHaveCount(22);
      expect(await labelClashes(page)).toEqual([]);
      const before = await centres(page);
      await graph.getByRole("button", { name: "Next" }).click();
      expectSamePlaces(await centres(page), before);
      expect(await labelClashes(page)).toEqual([]);
      await expect(graph.locator("[data-truncated]")).toHaveCount(0);
    });
  }
});

test("Dijkstra edges stay clear of unrelated nodes", async ({ page }) => {
  const graph = await showGraph(page, "dijkstra");
  await fontsLoaded(page);
  const clearances = await graph.getByTestId("graph-canvas").evaluate((canvas) => {
    const svg = canvas.querySelector("svg")!;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    const origin = svg.getBoundingClientRect();
    const nodes = [...canvas.querySelectorAll('[data-testid="graph-node"]')].map((node) => {
      const box = node.getBoundingClientRect();
      return { x: (box.x + box.width / 2 - origin.x) / scale, y: (box.y + box.height / 2 - origin.y) / scale, radius: box.width / scale / 2 };
    });
    const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3], [3, 4]];
    return [...svg.querySelectorAll<SVGPathElement>("path")].flatMap((path, i) => nodes.flatMap((node, j) => {
      if (pairs[i]!.includes(j)) return [];
      let distance = Infinity;
      const length = path.getTotalLength();
      for (let k = 0; k <= 300; k++) {
        const p = path.getPointAtLength(length * k / 300);
        distance = Math.min(distance, Math.hypot(p.x - node.x, p.y - node.y));
      }
      return [distance - node.radius];
    }));
  });
  expect(Math.min(...clearances)).toBeGreaterThan(5.8);
});
