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
  // Every scripted course gets the same title, and tests share a database, so follow this course's own entry.
  const sessionId = await entry.getAttribute("data-session-id");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(goal.slice(0, 60));
  const derivative = page.getByRole("region", { name: "Placement question: derivative" });
  const limit = page.getByRole("region", { name: "Placement question: limit" });
  await expect(derivative.getByRole("button", { name: "Not sure" })).toBeEnabled();
  await expect(derivative.getByText(/confiden/i)).toHaveCount(0);

  await derivative.getByRole("button", { name: "True" }).click();
  await expect(derivative.getByText("Correct.")).toBeVisible();
  await limit.getByRole("button", { name: "Not sure" }).click();
  await expect(limit.getByText("Marked as not sure.")).toBeVisible();

  // The last question is optional free text; the interview waits for it, then continues.
  const extra = page.getByRole("region", { name: "Anything else to add" });
  await expect(extra.getByText("Optional", { exact: true })).toBeVisible();
  await expect(extra.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByText("Your syllabus is ready.")).toHaveCount(0);
  await extra.getByRole("textbox").fill("I know the basics, but I want to dive into backprop.");
  await extra.getByRole("button", { name: "Send" }).click();
  await expect(extra.getByText("I know the basics, but I want to dive into backprop.")).toBeVisible();
  await expect(extra.getByRole("textbox")).toHaveCount(0);

  // Answering the last question continues automatically; the syllabus is written without approval.
  await expect(page.getByText("Your syllabus is ready.")).toBeVisible();
  await expect(course.getByText("In progress")).toBeVisible();
  await course.getByRole("button", { name: /Syllabus · 2 topics/ }).click();
  await expect(course.getByRole("list", { name: "Syllabus topics" })).toContainText("Limits");
  await expect(course.getByRole("list", { name: "What Mivra thinks you know" })).toContainText("From the test");

  // The tutor's title and subject icon replace the placeholder, without a reload.
  const titled = page.locator(`[data-session-id="${sessionId}"]`);
  await expect(titled).toContainText("Calculus for ML");
  await expect(titled.locator('svg[data-icon="sigma"]')).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Calculus for ML");
  await expect(page.locator("[data-session-id]").filter({ hasText: goal.slice(0, 60) })).toHaveCount(0);
  // The title is the only title: the goal shows once, labelled, inside the syllabus, not in the course bar (#133).
  await expect(course.getByText(goal)).toHaveCount(1);
  await expect(course.getByRole("region", { name: "Syllabus" })).toContainText(`Your goal: ${goal}`);

  // The first lesson is written when the learner reaches it, and becomes the page.
  await course.getByRole("button", { name: "Start lesson 1" }).click();
  const lesson = page.getByRole("article", { name: "What a limit is" });
  await expect(lesson.getByRole("region", { name: "The idea" })).toContainText("A limit is the value");
  const check = lesson.getByRole("region", { name: /^Check: limit/ });
  await expect(check).toBeVisible();
  await expect(lesson.getByRole("button", { name: "Finish lesson" })).toBeDisabled();

  // On desktop the status and the actions share one row.
  const top = async (box: Promise<{ y: number; height: number } | null>) => {
    const b = await box;
    return b ? b.y + b.height / 2 : -100;
  };
  await expect
    .poll(async () => Math.abs((await top(course.getByText("In progress").boundingBox())) - (await top(course.getByRole("button", { name: "Tutor" }).boundingBox()))))
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
  // The drawer slides shut slowly here, so the next Explain is pressed while it's still closing: the press
  // must reopen it and send, not be taken as a click outside the closing drawer or skipped as a used prompt.
  const slowClose = await page.addStyleTag({ content: '[data-slot="sheet-content"][data-state="closed"] { animation-duration: 3s !important; }' });
  await page.keyboard.press("Escape");
  await expect(lesson.getByRole("region", { name: "The idea", exact: true })).toContainText("Simpler: a limit is where f heads.");
  await expect(lesson.getByText("Version 3: Simpler")).toBeVisible();

  // Explain once more, so the last Explain was in this lesson when the learner moves on.
  await expect(page.locator('[data-slot="sheet-content"][data-state="closed"]')).toBeAttached();
  await lesson.getByRole("button", { name: "Explain: The idea" }).click();
  await expect(tutor.getByText("Here is more on the idea.")).toHaveCount(2);
  await slowClose.evaluate((style) => (style as Element).remove());
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
  // On a phone the course bar still shows its status and actions.
  await expect(course.getByText("In progress")).toBeInViewport();
  await expect(course.getByRole("button", { name: "Tutor" })).toBeInViewport();
  await page.getByRole("button", { name: "Back to lesson 2: Chain rule" }).click();
  await expect(page.getByRole("article", { name: "The chain rule" })).toBeVisible();
  await expect(page.getByText("You're looking at an earlier lesson.")).toHaveCount(0);
});

test("a lesson can show a code walkthrough section, at 320px too and after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Learning goal" }).fill(`React state placementcourse lessonwalkthrough ${Date.now()}`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("region", { name: "Placement question: derivative" }).getByRole("button", { name: "True" }).click();
  await page.getByRole("region", { name: "Placement question: limit" }).getByRole("button", { name: "Not sure" }).click();
  await page.getByRole("region", { name: "Anything else to add" }).getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText("Your syllabus is ready.")).toBeVisible();
  await page.getByRole("region", { name: "Course" }).getByRole("button", { name: "Start lesson 1" }).click();

  const lesson = page.getByRole("article", { name: "What a limit is" });
  const walk = lesson.getByRole("region", { name: /A click on Counter/ });
  await expect(walk).toContainText("Illustrated walkthrough");
  await expect(walk.getByTestId("step-counter")).toHaveText("Step 1 of 4");
  await expect(walk.getByTestId("walkthrough-output")).toContainText("Count: 0");
  await walk.getByRole("button", { name: "Next" }).click();
  await expect(walk.getByTestId("walkthrough-variable")).toHaveText(["handler.count= 0", "queued update= count + 1 = 1"]);
  // Stepping isn't answering: the lesson still waits for its one check.
  await expect(lesson.getByRole("button", { name: "Finish lesson" })).toBeDisabled();

  await page.reload();
  // Each worker has its own database, so the newest course is this one.
  await page.locator("[data-session-id]").filter({ hasText: "Calculus for ML" }).first().click();
  await expect(walk.getByTestId("step-counter")).toHaveText("Step 1 of 4");
  await page.setViewportSize({ width: 320, height: 800 });
  const [code, out] = [await walk.getByTestId("code-pane").boundingBox(), await walk.getByTestId("walkthrough-output").boundingBox()];
  expect(code!.y + code!.height).toBeLessThanOrEqual(out!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("a long expanded syllabus is its own scrolling panel, apart from the chat (#106)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Learning goal" }).fill(`Long plan placementcourse longsyllabus ${Date.now()}`);
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("region", { name: "Placement question: derivative" }).getByRole("button", { name: "True" }).click();
  await page.getByRole("region", { name: "Placement question: limit" }).getByRole("button", { name: "Not sure" }).click();
  await page.getByRole("region", { name: "Anything else to add" }).getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText("Your syllabus is ready.")).toBeVisible();

  const course = page.getByRole("region", { name: "Course" });
  const toggle = course.getByRole("button", { name: /Syllabus · 9 topics/ });
  const panel = course.getByRole("region", { name: "Syllabus" });
  const box = async (locator: ReturnType<typeof page.locator>) => (await locator.boundingBox())!;

  /** The panel sits above `below` without overlapping it, scrolls, and every part of it can be scrolled to. */
  const separate = async (below: ReturnType<typeof page.locator>) => {
    await expect(panel).toBeVisible();
    const [p, b] = [await box(panel), await box(below)];
    expect(p.y + p.height).toBeLessThanOrEqual(b.y + 1);
    expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    for (const last of [panel.getByRole("listitem").filter({ hasText: "Long topic 9" }), panel.getByText("known concept 3")]) {
      await last.scrollIntoViewIfNeeded();
      const l = await box(last);
      const p2 = await box(panel);
      expect(l.y).toBeGreaterThanOrEqual(p2.y - 1);
      expect(l.y + l.height).toBeLessThanOrEqual(p2.y + p2.height + 1);
    }
    // The panel has a visible edge: its own border, not just the list's.
    expect(await panel.evaluate((el) => getComputedStyle(el).borderBottomWidth)).not.toBe("0px");
  };

  // The interview: desktop, a short window (a laptop at about 120% zoom) and a phone.
  for (const size of [{ width: 1280, height: 800 }, { width: 1067, height: 520 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(size);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await separate(page.getByTestId("transcript"));
    // The composer stays on screen below the conversation.
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(composer).toBeInViewport();
    expect((await box(composer)).y).toBeGreaterThan((await box(panel)).y);
  }

  // The keyboard closes it, and the conversation gets its space back with its answers intact.
  await page.setViewportSize({ width: 1280, height: 800 });
  const before = (await box(page.getByTestId("transcript"))).height;
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  expect((await box(page.getByTestId("transcript"))).height).toBeGreaterThan(before);
  await expect(page.getByRole("region", { name: "Placement question: derivative" }).getByText("Correct.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // The lesson view keeps the same separation.
  await course.getByRole("button", { name: "Start lesson 1" }).click();
  await expect(page.getByRole("article", { name: "What a limit is" })).toBeVisible();
  for (const size of [{ width: 1280, height: 800 }, { width: 1067, height: 520 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(size);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await separate(page.getByTestId("lesson-scroll"));
  }
});
