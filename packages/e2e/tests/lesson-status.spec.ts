import { expect, test, type Page } from "../fixtures.js";

/** Runs the placement interview for a course whose goal holds `word`, and starts lesson 1. */
async function startFirstLesson(page: Page, word: string) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Learning goal" }).fill(`Limits placementcourse ${word} ${Date.now()}`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("region", { name: "Placement question: derivative" }).getByRole("button", { name: "True" }).click();
  await page.getByRole("region", { name: "Placement question: limit" }).getByRole("button", { name: "Not sure" }).click();
  await expect(page.getByText("Your syllabus is ready.")).toBeVisible();
  await page.getByRole("region", { name: "Course" }).getByRole("button", { name: "Start lesson 1" }).click();
  // The model holds the lesson, so the sidebar sees it being written.
  const entry = page.getByRole("navigation", { name: "Lessons" }).getByRole("button", { name: /^1\. Limits/ });
  await expect(entry).toHaveAccessibleName("1. Limits (being written)");
  await expect(entry.locator(".animate-spin")).toHaveCount(1);
  return entry;
}

test("the sidebar stops spinning once a lesson is written, without a reload", async ({ page, request }) => {
  const entry = await startFirstLesson(page, "lessonhold");
  await request.post("/e2e/release");
  await expect(page.getByRole("article", { name: "What a limit is" }).getByRole("button", { name: "Finish lesson" })).toBeVisible();
  await expect(entry.locator(".animate-spin")).toHaveCount(0);
  await expect(entry).toHaveAccessibleName("1. Limits (started)");
});

test("the sidebar stops spinning when a lesson fails, without a reload", async ({ page, request }) => {
  const entry = await startFirstLesson(page, "lessonbroken");
  await request.post("/e2e/release");
  await expect(page.getByText("The lesson stopped before it was finished.")).toBeVisible();
  await expect(entry.locator(".animate-spin")).toHaveCount(0);
  await expect(entry).toHaveAccessibleName("1. Limits (stopped)");
});
