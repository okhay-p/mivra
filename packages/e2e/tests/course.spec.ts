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

  // The first lesson is written when the learner reaches it, and becomes the page.
  await course.getByRole("button", { name: "Start lesson 1" }).click();
  const lesson = page.getByRole("article", { name: "What a limit is" });
  await expect(lesson.getByRole("region", { name: "The idea" })).toContainText("A limit is the value");
  const check = lesson.getByRole("region", { name: /^Check: limit/ });
  await expect(check).toBeVisible();
  await expect(lesson.getByRole("button", { name: "Finish lesson" })).toBeDisabled();

  // Ctrl+K opens the tutor; the interview is still in it.
  await page.keyboard.press("Control+k");
  const tutor = page.getByRole("dialog", { name: "Tutor" });
  await expect(tutor.getByText("Your syllabus is ready.")).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(tutor).toBeHidden();

  // Explain answers in the drawer and leaves the lesson as it is; Add to lesson keeps the answer.
  await lesson.getByRole("button", { name: "Explain: The idea" }).click();
  await expect(tutor.locator('[data-message-role="user"]').last()).toHaveText('Explain "The idea"');
  await expect(tutor.getByText("Here is more on the idea.")).toBeVisible();
  await expect(lesson.getByRole("region", { name: /^More on/ })).toHaveCount(0);
  await tutor.getByRole("button", { name: "Add to lesson" }).last().click();
  await expect(tutor.getByRole("button", { name: "Added to lesson" })).toBeVisible();
  await page.keyboard.press("Escape");
  const added = lesson.getByRole("region", { name: "More on The idea" });
  await expect(added).toContainText("Here is more on the idea.");
  await expect(added).toHaveAttribute("data-changed", "true");
  await expect(lesson.getByText("Version 2: Added the tutor's answer")).toBeVisible();

  // Change fills in the request for the learner to finish; the tutor makes a new version.
  await lesson.getByRole("button", { name: "Change: The idea" }).click();
  const box = tutor.getByRole("textbox", { name: "Message" });
  await expect(box).toHaveValue('Change "The idea": ');
  await box.fill('Change "The idea": changelesson simpler please');
  await tutor.getByRole("button", { name: "Send" }).click();
  await expect(tutor.getByText("I simplified it.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lesson.getByRole("region", { name: "The idea" })).toContainText("Simpler: a limit is where f heads.");
  await expect(lesson.getByText("Version 3: Simpler")).toBeVisible();

  // A wrong answer still finishes the lesson: scores never block moving on.
  await check.getByRole("button", { name: /^1/ }).click();
  await expect(check.getByText("Not quite.")).toBeVisible();
  await lesson.getByRole("button", { name: "Finish lesson" }).click();
  await expect(lesson.getByText("Finished. This lesson won't change.")).toBeVisible();
  await expect(lesson.getByRole("button", { name: "Next lesson: Chain rule" })).toBeVisible();
  await expect(lesson.getByRole("button", { name: /^Change/ })).toHaveCount(0);
});
