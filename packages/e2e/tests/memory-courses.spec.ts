import { expect, test, type Page } from "../fixtures.js";

// The memory panel lists the learner's courses, each with a way back into it (issue #135).

const openMemory = async (page: Page) => {
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  return page.getByRole("dialog", { name: "Memory" }).getByRole("region", { name: "Courses" });
};

test("the memory panel lists a course while it's set up, in progress and complete, and opens it", async ({ page }) => {
  await page.goto("/");
  const goal = `Limits placementcourse onetopic ${Date.now()}`;
  await page.getByRole("textbox", { name: "Learning goal" }).fill(goal);
  await page.getByRole("button", { name: "Start" }).click();
  const derivative = page.getByRole("region", { name: "Placement question: derivative" });
  await expect(derivative.getByRole("button", { name: "True" })).toBeEnabled();

  // Away from the course, the panel shows it as setting up, and its button returns to the interview.
  await page.getByRole("button", { name: "New course" }).click();
  await expect(page.getByRole("heading", { name: "What do you want to learn?" })).toBeVisible();
  let courses = await openMemory(page);
  const settingUp = courses.getByRole("listitem").filter({ hasText: goal });
  await expect(settingUp).toContainText("Setting up");
  await expect(settingUp).not.toContainText("finished");
  await settingUp.getByRole("button", { name: `Continue setting up ${goal}` }).click();
  await expect(page.getByRole("dialog", { name: "Memory" })).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(goal);
  await expect(derivative.getByRole("button", { name: "True" })).toBeEnabled();

  await derivative.getByRole("button", { name: "True" }).click();
  await page.getByRole("region", { name: "Placement question: limit" }).getByRole("button", { name: "Not sure" }).click();
  await page.getByRole("region", { name: "Anything else to add" }).getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText("Your syllabus is ready.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Limits in one go");

  // In progress: titled by the tutor, with the subject icon and its progress.
  courses = await openMemory(page);
  // Tests in a worker share a database, so this course is the newest one with its title.
  const entry = courses.getByRole("listitem").filter({ hasText: "Limits in one go" }).first();
  await expect(entry).toContainText("In progress");
  await expect(entry).toContainText("0 of 1 lessons finished");
  await expect(entry.locator('svg[data-icon="sigma"]')).toBeVisible();
  await page.keyboard.press("Escape");

  // Finishing the only lesson completes the course.
  const course = page.getByRole("region", { name: "Course" });
  await course.getByRole("button", { name: "Start lesson 1" }).click();
  const lesson = page.getByRole("article", { name: "What a limit is" });
  await lesson.getByRole("region", { name: /^Check: limit/ }).getByRole("button", { name: /^0/ }).click();
  await lesson.getByRole("button", { name: "Finish lesson" }).click();
  await expect(lesson.getByText("Finished. This lesson won't change.")).toBeVisible();
  await expect(course.getByText("Complete", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New course" }).click();
  courses = await openMemory(page);
  await expect(entry).toContainText("Complete");
  await expect(entry).toContainText("1 of 1 lessons finished");
  await entry.getByRole("button", { name: "Open Limits in one go" }).click();
  await expect(page.getByRole("dialog", { name: "Memory" })).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Limits in one go");
  await expect(course.getByText("Complete", { exact: true })).toBeVisible();
});
