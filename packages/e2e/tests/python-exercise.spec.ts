import { expect, test, type Locator, type Page } from "../fixtures.js";

// Pyodide loads about 12 MB and starts Python on the first run, and the server checks the reference in Pyodide
// too, both slow on a busy machine.
test.describe.configure({ timeout: 240_000 });
const PYTHON_MS = 120_000;

async function showExercise(page: Page, script: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  const prompt = `${script} ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByRole("region", { name: /^(Sum a list|Add two lines)$/ });
  await expect(card).toBeVisible({ timeout: PYTHON_MS });
  return { card, prompt };
}

const editor = (card: Locator) => card.getByRole("textbox", { name: /Your (submitted )?code/ });
const results = (card: Locator) => card.getByTestId("exercise-case").evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.result));
const status = (card: Locator) => card.getByTestId("exercise-status");

const SOLUTION = "def total(xs):\n    result = 0\n    for x in xs:\n        result += x\n    return result\n";

test.describe("python exercise", () => {
  test("runs the visible cases, then submits every case, in a worker with a strict CSP", async ({ page }) => {
    const csp: (string | null)[] = [];
    page.on("response", (response) => {
      if (response.url().includes("python-exercise.worker")) csp.push(response.headers()["content-security-policy"] ?? null);
    });
    const { card } = await showExercise(page, "exercisepysum");
    await expect(card).toContainText("Python · runs in your browser");
    expect(await page.content()).not.toContain("return sum(xs)");

    // The starter returns None, so the visible cases fail.
    await expect(editor(card)).toHaveValue("def total(xs):\n    # Your code here\n    pass\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(status(card)).toContainText("Starting Python");
    await expect(status(card)).toContainText("0 of 2 visible cases passed.", { timeout: PYTHON_MS });
    expect(await results(card)).toEqual(["failed", "failed", "pending"]);
    await expect(card.getByTestId("exercise-case").first()).toContainText("null");
    expect(csp).toEqual(["default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"]);

    await editor(card).fill(SOLUTION);
    await card.getByRole("button", { name: "Run" }).click();
    await expect(status(card)).toContainText("2 of 2 visible cases passed.");

    await card.getByRole("button", { name: "Submit" }).click();
    await expect(card.getByText("All cases passed!")).toBeVisible();
    await expect(card.getByText("3 of 3 cases passed, hidden ones included.")).toBeVisible();
    expect(await results(card)).toEqual(["passed", "passed", "passed"]);
  });

  test("learner code can't reach JavaScript or the network", async ({ page, baseURL }) => {
    const outside: string[] = [];
    page.context().on("request", (request) => {
      if (!request.url().startsWith(baseURL!) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) outside.push(request.url());
    });
    const { card } = await showExercise(page, "exercisepysum");
    // Each probe reports "open" if it got through. The returned list is shown as the case's return value.
    const probe = [
      "def attempt(name, action):",
      "    try:",
      "        action()",
      "        return name + ' open'",
      "    except BaseException as error:",
      "        return name + ' closed'",
      "",
      "def via_js():",
      "    import js",
      "    js.fetch('https://example.com/js')",
      "",
      "def via_api():",
      "    import pyodide_js",
      "",
      "def via_http():",
      "    from pyodide.http import open_url",
      "    open_url('https://example.com/http')",
      "",
      "def via_code():",
      "    from pyodide.ffi import to_js",
      "    to_js({}).constructor.constructor(\"return import('https://example.com/import.js')\")()",
      "",
      "def total(xs):",
      "    return [attempt(n, a) for n, a in [('js', via_js), ('api', via_api), ('http', via_http), ('code', via_code)]]",
    ].join("\n");
    await editor(card).fill(probe);
    await card.getByRole("button", { name: "Run" }).click();
    await expect(status(card)).toContainText("0 of 2 visible cases passed.", { timeout: PYTHON_MS });
    await expect(card.getByTestId("exercise-case").first()).toContainText('["js closed", "api closed", "http closed", "code closed"]');
    expect(outside).toEqual([]);
  });

  test("stops an infinite loop at the time limit and with Stop, and the editor recovers", async ({ page }) => {
    const { card } = await showExercise(page, "exercisepysum");
    await editor(card).fill("def total(xs):\n    while True:\n        pass\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(card.getByTestId("exercise-case").first()).toContainText("Time limit exceeded", { timeout: PYTHON_MS });
    await expect(status(card)).toContainText("0 of 2 visible cases passed.", { timeout: 30_000 });

    // A loop inside one long call into C never checks for the interrupt: Stop ends it at once.
    await editor(card).fill("def total(xs):\n    return sum(range(10 ** 15))\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(status(card)).toContainText("Running case 1 of 2");
    await card.getByRole("button", { name: "Stop" }).click();
    await expect(status(card)).toContainText("Stopped.");
    await expect(card.getByRole("button", { name: "Run" })).toBeEnabled();

    // A fixed version runs in a fresh worker.
    await editor(card).fill(SOLUTION);
    await card.getByRole("button", { name: "Run" }).click();
    await expect(status(card)).toContainText("2 of 2 visible cases passed.", { timeout: PYTHON_MS });
  });

  test("a stdio exercise reads input() and compares printed output", async ({ page }) => {
    const { card } = await showExercise(page, "exercisepylines");
    await editor(card).fill("a = int(input())\nb = int(input())\nprint(a + b)\n");
    await card.getByRole("button", { name: "Run" }).click();
    await expect(status(card)).toContainText("1 of 1 visible case passed.", { timeout: PYTHON_MS });
    await expect(card.getByTestId("exercise-case").first()).toContainText("Your output");
  });
});
