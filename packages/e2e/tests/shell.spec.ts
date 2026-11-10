import { expect, test, type Page } from "../fixtures.js";
import { makePdf } from "../../server/test/support/files.js";

const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

async function chooseTheme(page: Page, name: "System" | "Light" | "Dark") {
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

test.describe("theme", () => {
  test("an explicit choice overrides the OS and survives a reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Theme: System" })).toBeVisible();
    expect(await isDark(page)).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => isDark(page)).toBe(false);
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

  // Other tests add sessions meanwhile, so these count only what this page created or lists.
  const sessionEntries = (page: Page) => page.locator('[data-slot="sidebar-content"]').getByRole("button");

  test("New session saves nothing until the draft is sent, and keeps the draft's text", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Or just chat" })).toBeVisible();
    const before = await sessionEntries(page).count();
    const created: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/sessions") created.push(r.url());
    });

    const newSession = page.getByRole("button", { name: "New session" }).first();
    for (let i = 0; i < 3; i++) await newSession.click();
    const message = page.getByRole("textbox", { name: "Message" });
    await expect(page.getByText("Start a conversation", { exact: true })).toBeVisible();
    const prompt = `draft ${Date.now()}`;
    await message.fill(prompt);

    // Clicking again keeps the draft, its text and focus, and still saves nothing.
    await page.getByRole("button", { name: "New course" }).click();
    await newSession.click();
    await newSession.click();
    await expect(message).toHaveValue(prompt);
    await expect(message).toBeFocused();
    expect(created).toHaveLength(0);
    await expect(sessionEntries(page)).toHaveCount(before);
    await expect(page.locator("main h1")).toHaveText("New session");

    // Free chat from the start screen opens a draft too, and sending it saves the session.
    await page.reload();
    await page.getByRole("button", { name: "Or just chat" }).click();
    await expect(page.getByText("Start a conversation", { exact: true })).toBeVisible();
    await message.fill(prompt);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const session = page.locator('[data-slot="sidebar"]').getByRole("button", { name: prompt });
    await expect(session).toHaveAttribute("data-active", "true");
    await expect(page.locator('[data-slot="sidebar-group"]', { hasText: "Today" }).getByRole("button", { name: prompt })).toBeVisible();
    await expect(page.locator('[data-message-role="user"]')).toHaveText(prompt);
    await expect(page.getByText(/The server says/)).toBeVisible();
    expect(created).toHaveLength(1);
  });

  test("attaching a file to a draft saves the session and keeps the typed text", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New session" }).first().click();
    const message = page.getByRole("textbox", { name: "Message" });
    const typed = `typed ${Date.now()}`;
    await message.fill(typed);
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/sessions");
    const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/sessions\/[^/]+\/documents$/.test(new URL(r.url()).pathname));
    await page.getByTestId("document-input").setInputFiles({ name: "Draft notes.pdf", mimeType: "application/pdf", buffer: makePdf([["Notes attached before anything was sent."]]) });
    const session = (await (await created).json()) as { id: string };
    expect(new URL((await uploaded).url()).pathname).toBe(`/api/sessions/${session.id}/documents`);
    await expect(page.locator('[data-slot="sidebar"] [data-active="true"]')).toHaveText("New session");
    await expect(message).toHaveValue(typed);
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
    // A short formula has nothing to scroll, even where KaTeX draws a subscript or root a few px past its box.
    expect(await reply.locator("p").first().locator(".katex").evaluateAll((all) => all.map((k) => k.scrollWidth - k.clientWidth))).toEqual([0, 0, 0]);
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

  test("a reply nested too deeply shows as text without blocking the page", async ({ page }) => {
    await send(page, "deepnesting");
    const reply = page.locator("main div.math-text");
    await expect(reply.locator("strong")).toHaveText("still fine", { timeout: 30_000 });
    await expect(reply.locator("blockquote")).toHaveCount(0);
    await expect(reply).toContainText(`${">".repeat(2000)} deep`);
  });
});


test("the composer keeps keyboard sending and attachment help accessible", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await expect(page.getByText("Start a conversation", { exact: true })).toBeVisible();
  const composer = page.getByRole("group", { name: "Message composer", exact: true });
  const attach = composer.getByRole("button", { name: "Attach a PDF or PowerPoint file" });
  await attach.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Attach a PDF or PowerPoint file");
  // Padding next to Attach should focus Message, even though a hidden file input comes first.
  await composer.locator('[data-slot="input-group-addon"]').first().click({ position: { x: 2, y: 2 } });
  const message = composer.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeFocused();
  await message.fill("hello from the composer");
  await message.press("Enter");
  await expect(page.locator('[data-message-role="user"]')).toHaveText("hello from the composer");
  await expect(page.getByText("Start a conversation", { exact: true })).toHaveCount(0);
});
