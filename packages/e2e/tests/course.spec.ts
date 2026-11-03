import { expect, test } from "@playwright/test";

test("a course starts from the first screen, runs the placement interview and writes the syllabus", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What do you want to learn?" })).toBeVisible();
  const goal = `Calculus placementcourse ${Date.now()}`;
  await page.getByRole("textbox", { name: "Learning goal" }).fill(goal);
  await page.getByRole("button", { name: "Start" }).click();

  // The goal is sent as the first message, and the interview begins.
  await expect(page.locator('[data-message-role="user"]').first()).toHaveText(goal);
  const course = page.getByRole("region", { name: "Course" });
  await expect(course.getByText("Placement interview")).toBeVisible();
  const derivative = page.getByRole("region", { name: "Placement question: derivative" });
  const limit = page.getByRole("region", { name: "Placement question: limit" });
  await expect(derivative.getByRole("button", { name: "Not sure" })).toBeEnabled();
  await expect(derivative.getByText(/confiden/i)).toHaveCount(0);

  await derivative.getByRole("button", { name: "True" }).click();
  await expect(derivative.getByText("Correct.")).toBeVisible();
  await limit.getByRole("button", { name: "Not sure" }).click();
  await expect(limit.getByText("Marked as not sure.")).toBeVisible();

  // Answering the last question continues automatically; the syllabus is written without approval.
  await expect(page.getByText("Your syllabus is ready.")).toBeVisible();
  await expect(course.getByText("In progress")).toBeVisible();
  await course.getByRole("button", { name: /Syllabus · 2 topics/ }).click();
  await expect(course.getByRole("list", { name: "Syllabus topics" })).toContainText("Limits");
  await expect(course.getByRole("list", { name: "What Mivra thinks you know" })).toContainText("From the test");

  // The course is marked in the sidebar.
  await expect(page.getByRole("button", { name: goal.slice(0, 60) })).toBeVisible();
});
