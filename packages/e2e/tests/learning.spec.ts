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

  test("shows a safe error when the model fails, and the session still works", async ({ page }) => {
    await startSession(page);
    await send(page, "fail now");
    await expect(page.getByText("The model request failed.")).toBeVisible();
    await expect(page.getByText("PROVIDER-SECRET-DETAIL")).toHaveCount(0);

    await send(page, "hello again");
    await expect(page.getByText(/The server says/)).toBeVisible();
  });
});
