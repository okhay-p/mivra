import { expect, test, type Page } from "@playwright/test";

const SIZES = [
  { width: 1280, height: 720 },
  { width: 320, height: 640 },
];

/** The sidebar, opened first on a narrow screen, where its actions are behind a toggle. */
async function sidebar(page: Page) {
  if ((page.viewportSize()?.width ?? 0) >= 768) return page.locator("body");
  await page.getByRole("main").getByRole("button", { name: "Toggle Sidebar" }).click();
  return page.locator('[data-mobile="true"]');
}

async function send(page: Page, text: string, reply: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(reply)).toBeVisible();
}

/** The header and composer are on screen, the outer box has nothing to scroll, and the transcript scrolls itself. */
async function expectFrameInPlace(page: Page) {
  const { height } = page.viewportSize()!;
  const main = page.getByRole("main");
  await expect.poll(() => main.evaluate((e) => e.scrollTop)).toBe(0);
  expect(await main.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  const header = (await main.locator("header").boundingBox())!;
  expect(header.y).toBe(0);
  const composer = (await page.getByRole("textbox", { name: "Message" }).boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(height);
  // Below the transcript, not pulled up towards the header.
  expect(composer.y).toBeGreaterThan(height / 2);

  const transcript = page.getByTestId("transcript");
  const size = await transcript.evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight }));
  expect(size.scroll).toBeGreaterThan(size.client);
  await transcript.evaluate((e) => e.scrollTo({ top: 0, behavior: "instant" }));
  expect(await transcript.evaluate((e) => e.scrollTop)).toBe(0);
  await transcript.evaluate((e) => e.scrollTo({ top: e.scrollHeight, behavior: "instant" }));
  expect(await transcript.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await main.evaluate((e) => e.scrollTop)).toBe(0);
}

test.describe("a long session with several kinds of artifact", () => {
  for (const size of SIZES) {
    test(`stays in frame when reopened and resized, from ${size.width}px`, async ({ page }) => {
      test.setTimeout(60_000);
      const other = SIZES.find((s) => s !== size)!;
      await page.setViewportSize(size);
      await page.goto("/");
      await (await sidebar(page)).getByRole("button", { name: "New session" }).first().click();
      const name = `teach reopened ${Date.now()}`;
      await send(page, name, "Step through it, then answer the check.");
      await send(page, "graphweighted", "Here's the graph.");
      await send(page, "venn", "Step through the diagram.");
      await send(page, "truthtable", "Step through the table.");
      await send(page, "workedproof", "Reveal each step.");
      await expectFrameInPlace(page);

      await page.reload();
      await (await sidebar(page)).getByRole("button", { name }).click();
      await expect(page.getByText("Reveal each step.")).toBeVisible();
      await expectFrameInPlace(page);

      await page.setViewportSize(other);
      await expectFrameInPlace(page);
      await page.setViewportSize(size);
      await expectFrameInPlace(page);

      // Moving through the artifacts with the keyboard scrolls the transcript, never the frame.
      const counters = page.getByRole("button", { name: "Next" });
      for (let i = 0; i < (await counters.count()); i++) {
        await counters.nth(i).focus();
        await page.keyboard.press("Enter");
        expect(await page.getByRole("main").evaluate((e) => e.scrollTop)).toBe(0);
      }
      await expectFrameInPlace(page);
    });
  }
});

test.describe("long formulas in a graph and a set diagram", () => {
  for (const { script, region, reply, explanation } of [
    { script: "widegraph", region: /graph$/i, reply: "Scroll the long graph.", explanation: "graph-explanation" },
    { script: "wideset", region: /Set diagram/, reply: "Scroll the long diagram.", explanation: "set-explanation" },
  ]) {
    test(`${script}: arrow keys scroll the formula's box, and step from the card`, async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "New session" }).first().click();
      await send(page, `${script} ${Date.now()}`, reply);
      await page.setViewportSize({ width: 320, height: 800 });

      const card = page.getByRole("region", { name: region });
      const counter = card.getByTestId("step-counter");
      const title = card.getByRole("heading").getByTestId("step-scroll");
      const text = card.getByTestId(explanation).getByTestId("step-scroll");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      // A tab stop can't be hidden from screen readers.
      await expect(card.locator('[aria-hidden="true"] [data-testid="step-scroll"]')).toHaveCount(0);

      for (const box of [title, text]) {
        await expect(box).toHaveRole("group");
        await box.focus();
        await page.keyboard.press("ArrowRight");
        await expect(counter).toHaveText("Step 1 of 2");
        await expect.poll(() => box.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
      }
      // Only the box is a stop: the formula inside it doesn't scroll by itself.
      expect(await card.locator(".step-scroll .katex").evaluateAll((all) => all.every((k) => getComputedStyle(k).overflowX === "visible"))).toBe(true);

      await card.focus();
      await page.keyboard.press("ArrowRight");
      await expect(counter).toHaveText("Step 2 of 2");
    });
  }
});
