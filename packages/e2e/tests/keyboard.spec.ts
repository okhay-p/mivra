import { expect, test, type Locator, type Page } from "@playwright/test";

async function showAt320(page: Page, script: string, reply: string, region: RegExp) {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(`${script} ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(reply)).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  const card = page.getByRole("region", { name: region });
  await expect(card).toBeVisible();
  return card;
}

/**
 * Every stop real Tab presses reach inside a card, marking each with `data-stop` so it can be used again.
 * Chromium makes overflowing scrollers stops by itself, so looking for `tabindex` would miss them.
 */
async function tabStops(page: Page, card: Locator) {
  await card.focus();
  const stops: { text: string; hidden: boolean; scrolls: boolean; name: string | null; button: boolean }[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const stop = await card.evaluate((root, at) => {
      const active = document.activeElement;
      if (!active || active === root || !root.contains(active)) return null;
      active.setAttribute("data-stop", String(at));
      return {
        text: active.textContent ?? "",
        hidden: active.closest('[aria-hidden="true"]') !== null,
        scrolls: active.scrollWidth > active.clientWidth,
        name: active.getAttribute("aria-label"),
        button: active.tagName === "BUTTON",
      };
    }, i);
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

test.describe("keyboard stops at 320px", () => {
  for (const [script, reply, region] of [
    ["tabset", "Tab through the diagram.", /Set diagram/],
    ["tabgraph", "Tab through the graph.", /graph$/i],
    ["tabtrace", "Tab through the trace.", /Algorithm trace/],
    ["tabtable", "Tab through the table.", /Long cells/],
  ] as const) {
    test(`${script}: Tab never lands in something hidden, and every box is named and scrolls instead of stepping`, async ({ page }) => {
      const card = await showAt320(page, script, reply, region);
      const counter = card.getByTestId("step-counter");
      const stops = await tabStops(page, card);
      expect(stops.filter((stop) => stop.hidden)).toEqual([]);
      expect(stops.filter((stop) => stop.button).length).toBe(3);

      const boxes = stops.flatMap((stop, at) => (stop.button ? [] : [{ ...stop, at }]));
      expect(boxes.length).toBeGreaterThan(0);
      for (const { at, name, scrolls } of boxes) {
        expect(name).toBeTruthy();
        expect(scrolls).toBe(true);
        const box = card.locator(`[data-stop="${at}"]`);
        await box.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => box.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
        await expect(counter).toHaveText("Step 1 of 2");
      }

      await card.focus();
      await page.keyboard.press("ArrowRight");
      await expect(counter).toHaveText("Step 2 of 2");
    });
  }

  for (const [script, reply, region] of [
    ["tabgraph", "Tab through the graph.", /graph$/i],
    ["tabtrace", "Tab through the trace.", /Algorithm trace/],
  ] as const) {
    test(`${script}: a long variable wraps inside the card rather than running off it`, async ({ page }) => {
      const card = await showAt320(page, script, reply, region);
      const inCard = await card.evaluate((root) => {
        const { right } = root.getBoundingClientRect();
        return [...root.querySelectorAll("dl > *")].every((chip) => chip.getBoundingClientRect().right <= right);
      });
      expect(inCard).toBe(true);
    });
  }

  test("what's cut off or too wide in a set diagram can all be read in full, and fits the page", async ({ page }) => {
    const card = await showAt320(page, "tabset", "Tab through the diagram.", /Set diagram/);
    const list = card.getByTestId("set-overflow");
    await expect(list).toContainText("Top left label:");
    await expect(list).toContainText("Universe:");
    const reachable = (formula: string) => card.locator('[data-testid="step-scroll"]', { hasText: formula });
    for (const letter of ["W", "U", "M", "V"]) await expect(reachable(letter.repeat(22)).first()).toBeVisible();
    // Screen readers get each of these once, from the description rather than the boxes.
    await expect(card.getByTestId("set-description")).toContainText("M".repeat(22));
    await expect(list.locator('[data-testid="step-scroll"] > [aria-hidden="true"]').first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const inCard = await card.evaluate((root) => {
      const { right } = root.getBoundingClientRect();
      return [...root.querySelectorAll('[data-testid="set-key"] > *, [data-testid="set-variables"] > *')].every((item) => item.getBoundingClientRect().right <= right);
    });
    expect(inCard).toBe(true);
  });
});
