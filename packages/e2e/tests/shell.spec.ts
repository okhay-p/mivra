import { expect, test, type Page } from "@playwright/test";

const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

async function chooseTheme(page: Page, name: "System" | "Light" | "Dark") {
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

test.describe("theme", () => {
  test("follows the OS by default, including when it changes", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Theme: System" })).toBeVisible();
    expect(await isDark(page)).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => isDark(page)).toBe(false);
  });

  test("an explicit choice overrides the OS and survives a reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await chooseTheme(page, "Dark");
    expect(await isDark(page)).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Theme: Dark" })).toBeVisible();
    expect(await isDark(page)).toBe(true);

    await chooseTheme(page, "System");
    expect(await isDark(page)).toBe(false);
  });

  test("is applied before the app's script runs, so the page never flashes", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("mivra-theme", "dark"));
    await page.route("**/assets/*.js", (route) => route.abort());
    await page.reload();
    expect(await isDark(page)).toBe(true);
  });
});

test.describe("sidebar", () => {
  test("collapses to icons with the shortcut and expands again", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto("/");
    const main = page.getByRole("main");
    await expect.poll(async () => (await main.boundingBox())?.x).toBe(256);
    await page.keyboard.press("Control+b");
    await expect.poll(async () => (await main.boundingBox())?.x).toBe(48);
    await page.keyboard.press("Control+b");
    await expect.poll(async () => (await main.boundingBox())?.x).toBe(256);
  });

  test("lists a new session under Today and highlights it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New session" }).first().click();
    const prompt = `hello ${Date.now()}`;
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();

    const session = page.locator('[data-slot="sidebar"]').getByRole("button", { name: prompt });
    await expect(session).toHaveAttribute("data-active", "true");
    await expect(page.locator('[data-slot="sidebar-group"]', { hasText: "Today" }).getByRole("button", { name: prompt })).toBeVisible();
  });

  test("is an overlay on mobile that closes after choosing a session", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const toggle = page.getByRole("main").getByRole("button", { name: "Toggle Sidebar" });
    const sheet = page.locator('[data-mobile="true"]');

    await toggle.click();
    await sheet.getByRole("button", { name: "New session" }).first().click();
    await expect(sheet).toHaveCount(0);
    const prompt = `hello ${Date.now()}`;
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/The server says/)).toBeVisible();

    await page.reload();
    await toggle.click();
    await sheet.getByRole("button", { name: prompt }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText(/The server says/)).toBeVisible();
  });
});

test.describe("narrow screens", () => {
  // Only the first "New session" match is the action; sessions from earlier tests can share its name.
  for (const width of [320, 390]) {
    test(`long values and answers don't overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByRole("main").getByRole("button", { name: "Toggle Sidebar" }).click();
      await page.locator('[data-mobile="true"]').getByRole("button", { name: "New session" }).first().click();
      await page.getByRole("textbox", { name: "Message" }).fill("wide please");
      await page.getByRole("button", { name: "Send" }).click();

      const check = page.getByRole("region", { name: /^Check/ });
      await expect(page.getByText(/A long word in prose/)).toBeVisible();
      await check.getByRole("button").first().click();
      await expect(check.getByText("Not quite.")).toBeVisible();

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Nothing escapes the viewport, apart from the trace grid, which scrolls inside its own box.
      const escaped = await page.evaluate(() =>
        [...document.querySelectorAll("main *")]
          .filter((e) => !e.closest(".overflow-x-auto") && !e.closest(".sr-only") && e.getBoundingClientRect().right > innerWidth + 1)
          .map((e) => e.tagName),
      );
      expect(escaped).toEqual([]);

      // A long trace value stays on one line, above its pointer.
      const firstCell = page.getByTestId("trace-cell").first();
      const lines = await firstCell.evaluate((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell.firstChild!);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      });
      expect(lines).toBe(1);
      const cell = await firstCell.boundingBox();
      const pointer = await page.getByTestId("trace-pointer").first().boundingBox();
      expect(pointer!.y).toBeGreaterThanOrEqual(cell!.y + cell!.height);
    });
  }
});

test.describe("markdown and maths", () => {
  test("a reply renders real markup, and a long formula scrolls in its own box at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/");
    await page.getByRole("main").getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.locator('[data-mobile="true"]').getByRole("button", { name: "New session" }).first().click();
    await page.getByRole("textbox", { name: "Message" }).fill("maths please");
    await page.getByRole("button", { name: "Send" }).click();

    const reply = page.locator("main .math-text");
    await expect(reply.locator("strong")).toHaveText("really bold");
    await expect(reply.locator(".katex").first()).toBeVisible();
    await expect(reply.locator(".katex-display")).toHaveCount(1);
    await expect(reply).toContainText("it costs $5 and $10.");
    const text = await reply.locator("p").first().evaluate((p) => p.cloneNode(true).textContent);
    expect(text).not.toContain("**");
    expect(text).not.toContain("$x^2$");
    // KaTeX's stylesheet matches its markup: a superscript is smaller than the base text.
    const sizes = await reply.locator(".katex .msupsub .sizing").first().evaluate((sup) => [parseFloat(getComputedStyle(sup).fontSize), parseFloat(getComputedStyle(sup.closest(".katex")!).fontSize)]);
    expect(sizes[0]!).toBeLessThan(sizes[1]!);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const box of [reply.locator(".katex-display"), reply.locator("p .katex").last()]) {
      const fit = await box.evaluate((e) => ({ scrolls: e.scrollWidth > e.clientWidth, right: e.getBoundingClientRect().right }));
      expect(fit.scrolls).toBe(true);
      expect(fit.right).toBeLessThanOrEqual(320);
    }
  });

  async function send(page: Page, message: string) {
    await page.goto("/");
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByRole("textbox", { name: "Message" }).fill(message);
    await page.getByRole("button", { name: "Send" }).click();
  }

  test("artifact text keeps answers literal, renders only formulas, and replies keep markdown", async ({ page }) => {
    await send(page, "literals please");

    const check = page.getByRole("region", { name: /^Check/ });
    const options = check.getByRole("group", { name: "Options" }).getByRole("button");
    await expect(options.nth(0)).toHaveText("2*3*4");
    await expect(options.nth(1)).toHaveText("234");
    await expect(options.nth(2).locator(".katex")).toHaveCount(1);
    await expect(check.locator("em")).toHaveCount(0);
    await expect(check).toContainText("Which is *the* product");

    const trace = page.getByRole("region", { name: /^Algorithm trace/ });
    await expect(trace.getByRole("heading")).toContainText("Swap *demo* in");
    await expect(trace.getByRole("heading").locator(".katex")).toHaveCount(1);
    await expect(trace).toContainText("Multiply 2*3*4 and compare");
    await expect(trace).toContainText("for $5 or $10.");

    const reply = page.locator("main div.math-text");
    await expect(reply.locator("strong")).toHaveText("sum");
    await expect(reply.locator("p code")).toHaveText("$x$");
    await expect(reply).toContainText("costs $5 and $10, see $x$");
    await expect(reply.locator("a")).toHaveAttribute("href", "https://example.com/");
  });

  test("a long streamed reply keeps its dollars as text", async ({ page }) => {
    await send(page, "currencyparagraph");
    const reply = page.locator("main div.math-text");
    await expect(reply).toContainText("$44", { timeout: 60_000 });
    await expect(reply.locator(".katex")).toHaveCount(0);
    expect((await reply.textContent())!.match(/\$\d+/g)).toHaveLength(40);
  });

  test("a long streamed reply renders every formula", async ({ page }) => {
    await send(page, "formulablocks");
    const reply = page.locator("main div.math-text");
    await expect(reply.locator(".katex")).toHaveCount(100, { timeout: 60_000 });
  });

  test("a paragraph of intervals after an inequality renders every formula", async ({ page }) => {
    await send(page, "intervals");
    const reply = page.locator("main div.math-text");
    await expect(reply.locator(".katex")).toHaveCount(67);
    await expect(reply.locator(".math-text-literal")).toHaveCount(0);
  });

  test("a reply nested too deeply shows as text without blocking the page", async ({ page }) => {
    await send(page, "deepnesting");
    const reply = page.locator("main div.math-text");
    await expect(reply.locator("strong")).toHaveText("still fine", { timeout: 30_000 });
    await expect(reply.locator("blockquote")).toHaveCount(0);
    await expect(reply).toContainText(`${">".repeat(2000)} deep`);
  });
});
