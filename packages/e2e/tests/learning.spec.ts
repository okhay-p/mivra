import { expect, test, type Page } from "@playwright/test";

async function startSession(page: Page) {
  await page.goto("/");
  // The first match is the sidebar's action; sessions from earlier tests can share its name.
  await page.getByRole("button", { name: "New session" }).first().click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

/** A prompt that runs the "teach" script and names its session uniquely, since tests share a database. */
const teachPrompt = () => `teach me ${Date.now()}`;

const trace = (page: Page) => page.getByRole("region", { name: /Algorithm trace/ });
const check = (page: Page) => page.getByRole("region", { name: /^Check/ });
const option = (page: Page, name: RegExp) => check(page).getByRole("button", { name });
const cells = (page: Page) => trace(page).getByTestId("trace-cell");
/** Each cell's value, without the small index label inside it. */
const expectCells = (page: Page, values: string[]) =>
  expect
    .poll(() => cells(page).evaluateAll((all) => all.map((cell) => cell.firstChild?.textContent)))
    .toEqual(values);

test.describe("learning flow", () => {
  test("teaches, grades a wrong answer, keeps it after reload and tells the tutor", async ({ page }) => {
    await startSession(page);
    const prompt = teachPrompt();
    await send(page, prompt);
    await expect(page.getByText("Step through it, then answer the check.")).toBeVisible();

    // Values persist until replaced; pointers, ranges and variables belong to their own step.
    await expect(cells(page).first()).toContainText("3");
    await expect(trace(page).getByTestId("trace-range")).toBeVisible();
    await expect(trace(page).getByTestId("trace-pointer")).toHaveCSS("grid-column-start", "1");
    await expect(trace(page).getByText("swaps")).toBeVisible();

    await trace(page).getByRole("button", { name: "Next" }).click();
    await expect(trace(page).getByText("Swap them.")).toBeVisible();
    await expectCells(page, ["1", "3", "2"]);
    await expect(trace(page).getByTestId("trace-range")).toHaveCount(0);
    await expect(trace(page).getByTestId("trace-pointer")).toHaveCount(0);
    await expect(trace(page).getByText("swaps")).toHaveCount(0);

    await trace(page).getByRole("button", { name: "Next" }).click();
    await expect(trace(page).getByText("Move on.")).toBeVisible();
    await expectCells(page, ["1", "3", "2"]);
    await expect(trace(page).getByTestId("trace-pointer")).toHaveCSS("grid-column-start", "2");

    await trace(page).getByRole("button", { name: "Prev" }).click();
    await trace(page).getByRole("button", { name: "Prev" }).click();
    await expect(trace(page).getByText("Compare the first two.")).toBeVisible();
    await expectCells(page, ["3", "1", "2"]);

    await option(page, /^None/).click();
    await expect(check(page).getByText("Not quite.")).toBeVisible();
    await expect(option(page, /^None/)).toHaveAttribute("data-result", "incorrect");
    await expect(option(page, /^One/)).toHaveAttribute("data-result", "correct");
    await expect(check(page).getByText("SECRET-EXPLANATION")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: prompt }).click();
    await expect(check(page).getByText("Not quite.")).toBeVisible();
    await expect(option(page, /^Two/)).toBeDisabled();

    await send(page, "what did I get?");
    await expect(page.getByText("The server says the answer was: incorrect.")).toBeVisible();
  });

  test("a correct answer is graded as correct", async ({ page }) => {
    await startSession(page);
    await send(page, teachPrompt());
    await option(page, /^One/).click();
    await expect(check(page).getByText("Correct!")).toBeVisible();
  });

  test("a new session knows what was practised in an earlier one", async ({ page }) => {
    const concept = `concept${Date.now()}`;
    await startSession(page);
    await send(page, `recall ${concept}`);
    await expect(page.getByText("Record: nothing.")).toBeVisible();

    await startSession(page);
    await send(page, `practise ${concept}`);
    await option(page, /^None/).click();
    await expect(check(page).getByText("Not quite.")).toBeVisible();

    await startSession(page);
    await send(page, `recall ${concept}`);
    await expect(page.getByText("Record: 1 answered, 0 right, last incorrect.")).toBeVisible();
  });

  test("a memory reaches new sessions, and can be edited and deleted from the panel", async ({ page }) => {
    const topic = `topic${Date.now()}`;
    const edited = `edited${Date.now()}`;
    await startSession(page);
    await send(page, `note ${topic}`);
    await expect(page.getByText("Noted.")).toBeVisible();

    await startSession(page);
    await send(page, `known ${topic}`);
    await expect(page.getByText("Yes, I know that.")).toBeVisible();

    await page.getByRole("button", { name: "Memory", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Memory" });
    const entry = panel.getByRole("listitem").filter({ hasText: topic });
    await expect(entry).toContainText("From chat");
    await entry.getByRole("button", { name: "Edit" }).click();
    await panel.getByRole("textbox", { name: "Memory text" }).fill(`Wants to learn ${edited}`);
    await panel.getByRole("button", { name: "Save" }).click();
    const editedEntry = panel.getByRole("listitem").filter({ hasText: edited });
    await expect(editedEntry).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Memory", exact: true })).toBeFocused();

    await startSession(page);
    await send(page, `known ${edited}`);
    await expect(page.getByText("Yes, I know that.")).toBeVisible();

    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await editedEntry.getByRole("button", { name: "Delete" }).click();
    await editedEntry.getByRole("button", { name: "Yes, delete" }).click();
    await expect(editedEntry).toHaveCount(0);
    await page.keyboard.press("Escape");

    await startSession(page);
    await send(page, `known ${edited}`);
    await expect(page.getByText("No, I don't know that.")).toBeVisible();
  });

  test("never sends the answer key before the learner answers", async ({ page }) => {
    await startSession(page);
    const prompt = teachPrompt();
    const reply = page.waitForResponse((r) => r.url().endsWith("/chat"));
    await send(page, prompt);
    const stream = await (await reply).text();
    await expect(option(page, /^None/)).toBeEnabled();

    const reload = page.waitForResponse((r) => r.url().endsWith("/messages"));
    await page.reload();
    await page.getByRole("button", { name: prompt }).click();
    const stored = await (await reload).text();
    await expect(check(page)).toBeVisible();

    for (const body of [stream, stored, await page.content()]) {
      expect(body).not.toContain("SECRET");
      expect(body).not.toContain("correctOptionIndex");
    }
  });

  test("a check can't be answered until its reply finishes", async ({ page, request }) => {
    await startSession(page);
    await send(page, "slow please");
    await expect(check(page).getByText("Answer once the reply finishes.")).toBeVisible();
    await expect(option(page, /^One/)).toBeDisabled();

    await request.post("/e2e/release");
    await expect(page.getByText("Take your time.")).toBeVisible();
    await expect(option(page, /^One/)).toBeEnabled();
    await option(page, /^One/).click();
    await expect(check(page).getByText("Correct!")).toBeVisible();
  });

  test("a truth table steps with persistent cells, and a wide table scrolls in its own box at 320px", async ({ page }) => {
    await startSession(page);
    await send(page, `truthtable ${Date.now()}`);
    await expect(page.getByText("Step through the table.")).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });

    const table = page.getByRole("region", { name: /^Table: Truth table/ });
    const cells = table.getByTestId("table-cell");
    const texts = () => cells.evaluateAll((all) => all.map((cell) => cell.textContent));
    // p, q and the result column, row by row.
    await expect.poll(texts).toEqual(["T", "T", "T", "T", "F", "", "F", "T", "", "F", "F", ""]);
    await expect(table.getByRole("columnheader")).toHaveCount(3);
    await expect(cells.nth(0)).toHaveAttribute("data-tone", "active");
    await expect(table.locator(".katex").first()).toBeVisible();
    // A formula in hidden text would otherwise be a scroller, and so a tab stop nobody can see.
    expect(await table.locator("caption .katex").evaluate((e) => getComputedStyle(e).overflowX)).toBe("visible");

    const next = table.getByRole("button", { name: "Next" });
    await next.click();
    await expect(table.getByText("One input is false.")).toBeVisible();
    await expect.poll(texts).toEqual(["T", "T", "T", "T", "F", "F", "F", "T", "", "F", "F", ""]);
    // The first step's highlight has gone; its cell hasn't.
    await expect(cells.nth(0)).not.toHaveAttribute("data-tone");
    await expect(cells.nth(3)).toHaveAttribute("data-tone", "active");

    // Stepping to the end keeps the keyboard's place.
    await next.click();
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(next).toBeFocused();
    await expect.poll(texts).toEqual(["T", "T", "T", "T", "F", "F", "F", "T", "F", "F", "F", "F"]);
    await page.keyboard.press("ArrowLeft");
    await expect(table.getByText("One input is false.")).toBeVisible();

    const wide = page.getByRole("region", { name: /wide relation matrix/ });
    await wide.scrollIntoViewIfNeeded();
    await expect(wide.getByRole("rowheader")).toHaveCount(2);
    const fit = await wide.getByTestId("table-scroll").evaluate((box) => ({
      overflows: box.scrollWidth > box.clientWidth,
      right: box.getBoundingClientRect().right,
      page: document.documentElement.scrollWidth,
    }));
    expect(fit.overflows).toBe(true);
    expect(fit.right).toBeLessThanOrEqual(320);
    expect(fit.page).toBeLessThanOrEqual(320);
  });

  test("worked steps reveal cumulatively, and show all reveals the rest", async ({ page }) => {
    await startSession(page);
    await send(page, `workedproof ${Date.now()}`);
    await expect(page.getByText("Reveal each step.")).toBeVisible();

    const worked = page.getByRole("region", { name: /^Worked steps/ });
    const steps = worked.getByTestId("worked-step");
    await expect(steps).toHaveCount(1);
    await expect(steps.first()).toContainText("Base case");
    await expect(worked.getByText("Inductive step")).toHaveCount(0);

    await worked.getByRole("button", { name: "Next" }).click();
    await expect(steps).toHaveCount(2);
    await expect(steps.first()).toContainText("by direct calculation");

    const showAll = worked.getByRole("button", { name: "Show all" });
    await showAll.click();
    await expect(steps).toHaveCount(3);
    await expect(steps.last().locator(".katex").first()).toBeVisible();
    const restart = worked.getByRole("button", { name: "Start over" });
    await expect(restart).toBeFocused();
    await restart.click();
    await expect(steps).toHaveCount(1);
  });

  test("a formula too wide for a phone scrolls with the arrow keys, without stepping or losing focus", async ({ page }) => {
    await startSession(page);
    await send(page, `wideproof ${Date.now()}`);
    await expect(page.getByText("Scroll the long one.")).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });

    const worked = page.getByRole("region", { name: /^Worked steps/ });
    const steps = worked.getByTestId("worked-step");
    await worked.getByRole("button", { name: "Next" }).click();
    await expect(steps).toHaveCount(2);

    // Only the boxes that overflow are tab stops: the title and the long statement.
    await expect(worked.getByRole("group", { name: /scrolls sideways/ })).toHaveCount(2);
    await expect(worked.getByRole("heading").getByRole("group")).toHaveCount(1);
    await expect(steps.nth(0).getByRole("group")).toHaveCount(0);
    const box = steps.nth(1).getByRole("group", { name: /scrolls sideways/ });
    await expect(box).toHaveCount(1);
    const fit = await box.evaluate((e) => ({ scrolls: e.scrollWidth > e.clientWidth, right: e.getBoundingClientRect().right, page: document.documentElement.scrollWidth }));
    expect(fit.scrolls).toBe(true);
    expect(fit.right).toBeLessThanOrEqual(320);
    expect(fit.page).toBeLessThanOrEqual(320);

    const scrollLeft = () => box.evaluate((e) => e.scrollLeft);
    await box.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(scrollLeft).toBeGreaterThan(0);
    await expect(steps).toHaveCount(2);
    await expect(box).toBeFocused();
    const scrolled = await scrollLeft();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(scrollLeft).toBeLessThan(scrolled);
    await expect(steps).toHaveCount(2);
    await expect(box).toBeFocused();

    // Away from the formula, the arrow keys still step.
    await worked.focus();
    await page.keyboard.press("ArrowRight");
    await expect(steps).toHaveCount(3);
    await page.keyboard.press("ArrowLeft");
    await expect(steps).toHaveCount(2);

    // A formula in a table's explanation behaves the same, and gains its tab stop when its step arrives.
    const table = page.getByRole("region", { name: /^Table: Same words/ });
    await expect(table.getByRole("group", { name: /Formula/ })).toHaveCount(0);
    await table.getByRole("button", { name: "Next" }).click();
    await table.getByRole("button", { name: "Next" }).click();
    const tableBox = table.getByRole("group", { name: /Formula/ });
    await tableBox.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => tableBox.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    await expect(table.getByTestId("step-counter")).toHaveText("Step 3 of 3");
  });

  test("a formula title too wide for a phone stays in its card and scrolls all the way", async ({ page }) => {
    await startSession(page);
    await send(page, `wideproof ${Date.now()}`);
    await expect(page.getByText("Scroll the long one.")).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });

    for (const name of [/^Worked steps/, /^Table: \$a_/]) {
      const card = page.getByRole("region", { name });
      const title = card.getByRole("heading").getByTestId("step-scroll");
      await expect(title).toHaveRole("group");
      const fit = await title.evaluate((box) => {
        const bounds = box.getBoundingClientRect();
        const outer = box.closest('[data-slot="card"]')!.getBoundingClientRect();
        const distance = box.scrollWidth - box.clientWidth;
        box.scrollLeft = distance;
        const end = box.querySelector(".katex")!.getBoundingClientRect().right;
        return { left: bounds.left, right: bounds.right, cardLeft: outer.left, cardRight: outer.right, distance, end, page: document.documentElement.scrollWidth };
      });
      expect(fit.left).toBeGreaterThanOrEqual(fit.cardLeft);
      expect(fit.right).toBeLessThanOrEqual(fit.cardRight);
      expect(fit.page).toBeLessThanOrEqual(320);
      // Well past a rounding error, and enough to bring the end of the formula into the box.
      expect(fit.distance).toBeGreaterThan(50);
      expect(fit.end).toBeLessThanOrEqual(fit.right + 1);
    }
  });

  test("a formula box keeps focus when it stops overflowing, and leaves no stray stop behind", async ({ page }) => {
    await startSession(page);
    await send(page, `wideproof ${Date.now()}`);
    await expect(page.getByText("Scroll the long one.")).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });

    const worked = page.getByRole("region", { name: /^Worked steps/ });
    const title = worked.getByRole("heading").getByTestId("step-scroll");
    await expect(title).toHaveAttribute("tabindex", "0");
    await title.focus();

    await page.setViewportSize({ width: 1280, height: 800 });
    // No longer named as something that scrolls, but the keyboard is still here.
    await expect(title).not.toHaveAttribute("role");
    await expect(title).not.toHaveAttribute("aria-label");
    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute("tabindex", "-1");

    // The window losing focus isn't the keyboard leaving: the box is still active, so it has to stay focusable.
    await title.evaluate((box) => box.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await expect(title).toHaveAttribute("tabindex", "-1");

    await page.keyboard.press("Tab");
    await expect(worked.getByRole("button", { name: "Prev" })).toBeFocused();
    await expect(title).not.toHaveAttribute("tabindex");
    await page.keyboard.press("Shift+Tab");
    await expect(worked).toBeFocused();

    // Clicking a formula that fits leaves the card focused, so its arrow keys still step.
    await title.click();
    await expect(worked).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(worked.getByTestId("worked-step")).toHaveCount(2);

    await page.setViewportSize({ width: 320, height: 800 });
    await expect(title).toHaveRole("group");
    await expect(title).toHaveAttribute("tabindex", "0");
  });

  test("the active tone is neutral and stands apart from muted, in both themes", async ({ page }) => {
    await startSession(page);
    await send(page, `truthtable ${Date.now()}`);
    await expect(page.getByText("Step through the table.")).toBeVisible();
    const cell = page.getByRole("region", { name: /^Table: Truth table/ }).locator('[data-tone="active"]').first();
    for (const dark of [false, true]) {
      await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
      const look = await cell.evaluate((e) => {
        const probe = document.createElement("div");
        document.body.append(probe);
        const resolve = (token: string) => {
          probe.style.color = `var(--${token})`;
          return getComputedStyle(probe).color;
        };
        const tokens = { foreground: resolve("foreground"), primary: resolve("primary"), accent: resolve("accent") };
        probe.remove();
        const style = getComputedStyle(e);
        return { ...tokens, background: style.backgroundColor, shadow: style.boxShadow };
      });
      expect(look.background).not.toBe(look.accent);
      expect(look.shadow).not.toContain(look.primary);
      expect(look.shadow).toContain(look.foreground);
    }
  });

  test("shows a safe error when the model fails, and the session still works", async ({ page }) => {
    await startSession(page);
    await send(page, "fail now");
    await expect(page.getByText("The model request failed.")).toBeVisible();
    await expect(page.getByText("PROVIDER-SECRET-DETAIL")).toHaveCount(0);

    await send(page, "hello again");
    await expect(page.getByText(/The server says/)).toBeVisible();
  });
});
