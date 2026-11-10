import { expect, test } from "../fixtures.js";

test("a course starts from the first screen, runs the placement interview and writes the syllabus", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What do you want to learn?" })).toBeVisible();
  // Long enough that the course bar has to truncate it on desktop.
  const goal = `Calculus for machine learning, from limits to backprop placementcourse ${Date.now()}`;
  await page.getByRole("textbox", { name: "Learning goal" }).fill(goal);
  await page.getByRole("button", { name: "Start" }).click();

  // The goal is sent as the first message, and the interview begins.
  await expect(page.locator('[data-message-role="user"]').first()).toHaveText(goal);
  const course = page.getByRole("region", { name: "Course" });
  await expect(course.getByText("Placement interview")).toBeVisible();
  // Until the syllabus, the course is titled after its goal, with the graduation cap.
  const entry = page.locator("[data-session-id]").filter({ hasText: goal.slice(0, 60) });
  await expect(entry.locator('svg[data-icon="graduation-cap"]')).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(goal.slice(0, 60));
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

  // The tutor's title and subject icon replace the placeholder, without a reload.
  const titled = page.locator("[data-session-id]").filter({ hasText: "Calculus for ML" });
  await expect(titled.locator('svg[data-icon="sigma"]')).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Calculus for ML");
  await expect(page.locator("[data-session-id]").filter({ hasText: goal.slice(0, 60) })).toHaveCount(0);

  // The first lesson is written when the learner reaches it, and becomes the page.
  await course.getByRole("button", { name: "Start lesson 1" }).click();
  const lesson = page.getByRole("article", { name: "What a limit is" });
  await expect(lesson.getByRole("region", { name: "The idea" })).toContainText("A limit is the value");
  const check = lesson.getByRole("region", { name: /^Check: limit/ });
  await expect(check).toBeVisible();
  await expect(lesson.getByRole("button", { name: "Finish lesson" })).toBeDisabled();

  // On desktop the goal truncates beside its status and actions instead of pushing them onto a second row.
  const top = async (box: Promise<{ y: number; height: number } | null>) => {
    const b = await box;
    return b ? b.y + b.height / 2 : -100;
  };
  await expect
    .poll(async () => Math.abs((await top(course.getByText(goal).first().boundingBox())) - (await top(course.getByRole("button", { name: "Tutor" }).boundingBox()))))
    .toBeLessThan(8);

  // Ctrl+K opens the tutor. The interview is folded away, and its replies can't be added to the lesson.
  await page.keyboard.press("Control+k");
  const tutor = page.getByRole("dialog", { name: "Tutor" });
  await expect(tutor.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Ask the tutor…");
  await expect(tutor.getByText("Your syllabus is ready.")).toHaveCount(0);
  await tutor.getByRole("button", { name: "Show the placement interview" }).click();
  await expect(tutor.getByText("Your syllabus is ready.")).toBeVisible();
  await expect(tutor.getByRole("button", { name: "Add to lesson" })).toHaveCount(0);
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
  await expect(lesson.getByRole("region", { name: "The idea", exact: true })).toContainText("Simpler: a limit is where f heads.");
  await expect(lesson.getByText("Version 3: Simpler")).toBeVisible();

  // Explain once more, so the last Explain was in this lesson when the learner moves on.
  await lesson.getByRole("button", { name: "Explain: The idea" }).click();
  await expect(tutor.getByText("Here is more on the idea.")).toHaveCount(2);
  await page.keyboard.press("Escape");

  // A wrong answer still finishes the lesson: scores never block moving on.
  await check.getByRole("button", { name: /^1/ }).click();
  await expect(check.getByText("Not quite.")).toBeVisible();
  await lesson.getByRole("button", { name: "Finish lesson" }).click();
  await expect(lesson.getByText("Finished. This lesson won't change.")).toBeVisible();
  await expect(lesson.getByRole("button", { name: "Next lesson: Chain rule" })).toBeVisible();
  await expect(lesson.getByRole("button", { name: /^Change/ })).toHaveCount(0);

  // The next lesson revisits the mistake with a link back, and Mivra adapts the plan once, visibly.
  await lesson.getByRole("button", { name: "Next lesson: Chain rule" }).click();
  const next = page.getByRole("article", { name: "The chain rule" });
  await expect(next.getByRole("region", { name: "Looking back" })).toContainText("Last time the limit check tripped you up.");
  await expect(course.getByText("Mivra changed the plan: Added a limits refresher: you missed 1 of 1 checks")).toBeVisible();

  // Add to lesson goes into the open lesson, even though the last Explain was in the earlier one.
  await page.keyboard.press("Control+k");
  await tutor.getByRole("textbox", { name: "Message" }).fill("what comes after this?");
  await tutor.getByRole("button", { name: "Send" }).click();
  await expect(tutor.locator('[data-message-role="assistant"]').last()).toContainText("The server says");
  await tutor.getByRole("button", { name: "Add to lesson" }).last().click();
  await expect(tutor.getByRole("button", { name: "Added to lesson" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(next.getByRole("region", { name: "From the tutor" })).toContainText("The server says");
  const toggle = course.getByRole("button", { name: /Syllabus/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(course.getByRole("list", { name: "Syllabus topics" })).toContainText("Limits refresher");

  // Undo restores the plan.
  await course.getByRole("button", { name: "Undo" }).click();
  await expect(course.getByText(/Mivra changed the plan/)).toHaveCount(0);
  await expect(course.getByRole("list", { name: "Syllabus topics" })).not.toContainText("Limits refresher");

  // The link back opens the earlier lesson at that section.
  await next.getByRole("button", { name: "What a limit is: The idea" }).click();
  const earlier = page.getByRole("article", { name: "What a limit is" });
  await expect(earlier.getByRole("region", { name: "The idea", exact: true })).toBeFocused();
  // An earlier lesson isn't the end of the course, and there's always a way back (also on a phone).
  await expect(earlier.getByText("You've reached the end of the syllabus.")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 800 });
  // On a phone the goal keeps a readable width; the course bar's actions wrap below it.
  await expect.poll(async () => (await course.getByText(goal).first().boundingBox())?.width ?? 0).toBeGreaterThan(150);
  await page.getByRole("button", { name: "Back to lesson 2: Chain rule" }).click();
  await expect(page.getByRole("article", { name: "The chain rule" })).toBeVisible();
  await expect(page.getByText("You're looking at an earlier lesson.")).toHaveCount(0);
});
