import { expect, test, type Locator, type Page } from "../fixtures.js";

/** Runs an exercise script in a new session, named uniquely since tests share a database. */
async function showExercise(page: Page, script: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  const prompt = `${script} ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByRole("region", { name: /^(Sum an array|Add two lines)$/ });
  // The server runs the reference first, in a subprocess that starts through tsx in the harness.
  await expect(card).toBeVisible({ timeout: 30_000 });
  return { card, prompt };
}

const editor = (card: Locator) => card.getByRole("textbox", { name: /Your (submitted )?code/ });
const results = (card: Locator) => card.getByTestId("exercise-case").evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.result));

async function typeCode(card: Locator, code: string) {
  await editor(card).fill(code);
}

const SOLUTION = "function sum(xs) {\n  let total = 0;\n  for (const x of xs) total += x;\n  return total;\n}\n";

test.describe("code exercise", () => {
  test("runs the visible cases, then submits every case, and a reload restores the code and results without running", async ({ page }) => {
    const { card, prompt } = await showExercise(page, "exercisesum");
    await expect(card).toContainText("Write `sum(xs)`".replaceAll("`", ""));
    await expect(page.getByText("Write sum, run it, then submit.")).toBeVisible();
    // The reference solution never reaches the page.
    expect(await page.content()).not.toContain("total + x, 0");
    await expect(card.getByTestId("exercise-case")).toHaveCount(3);
    await expect(card.getByTestId("exercise-case").nth(2)).toContainText("Case 3 (hidden)");
    await expect(card.getByTestId("exercise-case").nth(2)).not.toContainText("-5");

    // The starter returns undefined, so the visible cases fail; hidden ones aren't run.
    await expect(editor(card)).toHaveValue("function sum(xs) {\n  // Your code here\n}\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByTestId("exercise-status")).toContainText("0 of 2 visible cases passed.");
    expect(await results(card)).toEqual(["failed", "failed", "pending"]);
    await expect(card.getByTestId("exercise-case").first()).toContainText("sum([1,2,3])");

    await typeCode(card, SOLUTION);
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByTestId("exercise-status")).toContainText("2 of 2 visible cases passed.");
    expect(await results(card)).toEqual(["passed", "passed", "pending"]);

    await card.getByRole("button", { name: "Submit" }).click();
    await expect(card.getByText("All cases passed!")).toBeVisible();
    await expect(card.getByText("3 of 3 cases passed, hidden ones included.")).toBeVisible();
    expect(await results(card)).toEqual(["passed", "passed", "passed"]);
    await expect(card.getByRole("button", { name: "Submit" })).toHaveCount(0);

    // After a reload the saved code and results show at once, and nothing runs (no worker starts).
    let workers = 0;
    page.on("worker", (worker) => {
      if (worker.url().includes("exercise")) workers++;
    });
    await page.reload();
    await page.getByRole("button", { name: prompt }).click();
    const reloaded = page.getByRole("region", { name: "Sum an array" });
    await expect(reloaded.getByText("All cases passed!")).toBeVisible();
    await expect(editor(reloaded)).toHaveValue(SOLUTION);
    await expect(editor(reloaded)).toHaveAttribute("readonly", "");
    expect(await results(reloaded)).toEqual(["passed", "passed", "passed"]);
    expect(workers).toBe(0);
  });

  test("a failing hidden case fails the submission", async ({ page }) => {
    const { card } = await showExercise(page, "exercisesum");
    await typeCode(card, "function sum(xs) {\n  return xs.length ? xs.reduce((a, b) => a + Math.abs(b), 0) : 0;\n}\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByTestId("exercise-status")).toContainText("2 of 2 visible cases passed.");
    await card.getByRole("button", { name: "Submit" }).click();
    await expect(card.getByText("Not quite.")).toBeVisible();
    await expect(card.getByText("2 of 3 cases passed, hidden ones included.")).toBeVisible();
    expect(await results(card)).toEqual(["passed", "passed", "failed"]);
  });

  test("stops an infinite loop at the time limit and with Stop, and the editor recovers", async ({ page }) => {
    const { card } = await showExercise(page, "exercisesum");
    await typeCode(card, "function sum(xs) {\n  while (true) {}\n}\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByText(/Running case 1 of 2/)).toBeVisible();
    await expect(card.getByTestId("exercise-case").first()).toContainText("Time limit exceeded", { timeout: 15_000 });
    await expect(card.getByTestId("exercise-status")).toContainText("0 of 2 visible cases passed.", { timeout: 15_000 });
    await expect(card.getByRole("button", { name: "Run" })).toBeEnabled();

    // Stop ends a run at once and nothing is submitted.
    await card.getByRole("button", { name: "Submit" }).click();
    await card.getByRole("button", { name: "Stop" }).click();
    await expect(card.getByTestId("exercise-status")).toContainText("Stopped. Nothing was submitted.");
    await expect(card.getByRole("button", { name: "Submit" })).toBeEnabled();

    // A fixed version runs normally in a fresh worker.
    await typeCode(card, SOLUTION);
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByTestId("exercise-status")).toContainText("2 of 2 visible cases passed.");
  });

  test("stops runaway memory at the memory limit", async ({ page }) => {
    const { card } = await showExercise(page, "exercisesum");
    await typeCode(card, "function sum(xs) {\n  return new Array(5e7).fill(1).length;\n}\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByTestId("exercise-case").first()).toContainText("Memory limit exceeded", { timeout: 15_000 });
    await expect(card.getByRole("button", { name: "Run" })).toBeEnabled({ timeout: 15_000 });
  });

  test("a stdio exercise reads input lines and compares printed output", async ({ page }) => {
    const { card } = await showExercise(page, "exerciselines");
    await typeCode(card, "const a = Number(readLine());\nconst b = Number(readLine());\nconsole.log(a + b);\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByTestId("exercise-status")).toContainText("1 of 1 visible case passed.");
    await expect(card.getByTestId("exercise-case").first()).toContainText("Your output");
  });

  test("keeps an unsubmitted draft across a reload", async ({ page }) => {
    const { card, prompt } = await showExercise(page, "exercisesum");
    await typeCode(card, "function sum(xs) { return 42 }\n");
    await page.reload();
    await page.getByRole("button", { name: prompt }).click();
    await expect(editor(page.getByRole("region", { name: "Sum an array" }))).toHaveValue("function sum(xs) { return 42 }\n");
  });
});
