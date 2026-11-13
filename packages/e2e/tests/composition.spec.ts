import { expect, test, type Locator, type Page } from "../fixtures.js";

/** Runs a composition script in a new session, named uniquely since tests share a database. */
async function showCompositions(page: Page, script: string) {
  const prompt = `${script} ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  const cards = page.getByRole("region", { name: /Composition$/ });
  await expect(cards.first()).toBeVisible();
  return { prompt, cards };
}

/** What a card shows, group by group: each group's label and its cards' labels, properties, notes and references. */
const snapshot = (card: Locator) =>
  card.getByTestId("composition-group").evaluateAll((groups) =>
    groups.map((group) => ({
      group: group.querySelector("h4")?.textContent,
      entities: [...group.querySelectorAll<HTMLElement>('[data-testid="composition-entity"]')].map((entity) => ({
        id: entity.dataset.entity,
        tone: entity.dataset.tone,
        text: entity.textContent,
      })),
    })),
  );

const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("composition", () => {
  test("Python aliasing: references are chips, and seek, back and restart match stepping forward", async ({ page }) => {
    const { cards } = await showCompositions(page, "compositionalias");
    const card = cards.first();
    await expect(card).toContainText("Two names, one list");
    await expect(card.getByTestId("step-counter")).toHaveText("Step 1 of 4");
    await expect(card.getByTestId("composition-step-label")).toHaveText("a = [1, 2, 3]");
    // Hidden entities aren't in the page at all.
    await expect(card.locator('[data-entity="b"]')).toHaveCount(0);
    await expect(card.locator('[data-entity="list2"]')).toHaveCount(0);
    await expect(card.locator('[data-entity="a"]').getByTestId("composition-reference")).toHaveText(["→refers to list"]);
    // The first step describes what's there, and nothing is announced until the learner moves.
    await expect(card.getByTestId("composition-changes")).toContainText("At the start");
    await expect(card.getByTestId("composition-changes")).toContainText("Names holds a.");
    await expect(card.getByTestId("composition-status")).toHaveText("");

    const next = card.getByRole("button", { name: "Next" });
    const controlsAt = async () => (await next.boundingBox())!.y;
    const top = await controlsAt();
    const forward = [await snapshot(card)];
    for (let i = 1; i < 4; i++) {
      await next.click();
      await expect(card.getByTestId("step-counter")).toHaveText(`Step ${i + 1} of 4`);
      forward.push(await snapshot(card));
      // The controls are above the content, so they don't move as it changes.
      expect(await controlsAt()).toBe(top);
    }
    await expect(next).toBeFocused();

    // Step 4: b is rebound, both lists stay visible, and the chips swap.
    await expect(card.getByTestId("composition-step-label")).toHaveText("b = [9]");
    await expect(card.locator('[data-entity="b"]').getByTestId("composition-reference")).toHaveText(["→refers to new list"]);
    await expect(card.locator('[data-entity="list1"]')).toBeVisible();
    await expect(card.getByTestId("composition-changes")).toContainText("b → new list is connected.");
    await expect(card.getByTestId("composition-changes")).toContainText("b → list is disconnected.");
    await expect(card.getByTestId("composition-status")).toContainText("Step 4 of 4.");
    await expect(card.getByTestId("composition-status")).toContainText("b → list is disconnected.");

    // Direct seek, back and restart all land on what stepping forward showed.
    const seek = card.getByTestId("composition-seek");
    await seek.selectOption({ label: "Step 2: b = a" });
    expect(await snapshot(card)).toEqual(forward[1]);
    await expect(card.getByTestId("composition-changes")).toContainText("b appears in Names.");
    await card.getByRole("button", { name: "Prev" }).click();
    expect(await snapshot(card)).toEqual(forward[0]);
    await seek.selectOption("3");
    expect(await snapshot(card)).toEqual(forward[3]);
    // Step 4 restates the appended list in its own state, as nothing carries over.
    await expect(card.locator('[data-entity="list1"]')).toContainText("[1, 2, 3, 4]");
    await card.getByRole("button", { name: "Restart" }).click();
    expect(await snapshot(card)).toEqual(forward[0]);
    await expect(card.getByTestId("step-counter")).toHaveText("Step 1 of 4");

    // The keyboard steps the focused card: arrows, End and Home.
    await card.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await snapshot(card)).toEqual(forward[2]);
    await expect(card.locator('[data-entity="list1"]').getByTestId("composition-callout")).toContainText("Changed in place");
    await expect(card.locator('[data-entity="list1"]')).toHaveAttribute("data-tone", "active");
    await page.keyboard.press("End");
    expect(await snapshot(card)).toEqual(forward[3]);
    await page.keyboard.press("ArrowLeft");
    expect(await snapshot(card)).toEqual(forward[2]);
    await page.keyboard.press("Home");
    expect(await snapshot(card)).toEqual(forward[0]);
  });

  test("event loop: one task moves queue → stack → gone, and a reorder is described", async ({ page }) => {
    const { cards } = await showCompositions(page, "compositionloop");
    const card = cards.first();
    const queue = card.locator('[data-group="queue"]');
    const stack = card.locator('[data-group="stack"]');
    const ids = (group: Locator) => group.getByTestId("composition-entity").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.entity));
    // Ordered groups are lists whose first item is the front.
    await expect(queue.locator("ol")).toBeVisible();
    await expect(queue).toContainText("first at top");
    expect(await ids(queue)).toEqual(["timer", "click", "fetch"]);
    await expect(stack.getByTestId("composition-empty")).toHaveText("Empty");

    const next = card.getByRole("button", { name: "Next" });
    await next.click();
    expect(await ids(queue)).toEqual(["click", "timer", "fetch"]);
    await expect(card.getByTestId("composition-changes")).toContainText("Task queue is reordered: onClick, onTimeout, onResponse.");
    await expect(card.getByTestId("composition-changes")).toContainText("onClick: priority changes from normal to user input.");
    await next.click();
    expect(await ids(stack)).toEqual(["click"]);
    await expect(card.getByTestId("composition-changes")).toContainText("onClick moves from Task queue to Call stack.");
    // State isn't carried over: the declared priority is back.
    await expect(stack.locator('[data-entity="click"]')).toContainText("normal");
    await next.click();
    await expect(card.locator('[data-entity="click"]')).toHaveCount(0);
    await expect(stack.getByTestId("composition-empty")).toBeVisible();
    await expect(card.getByTestId("composition-changes")).toContainText("onClick leaves Call stack.");
  });

  test("pipeline: code and maths bodies, literal step labels and empty stages", async ({ page }) => {
    const { cards } = await showCompositions(page, "compositionpipeline");
    const card = cards.first();
    await expect(card.getByTestId("composition-step-label")).toHaveCount(0);
    await expect(card.getByTestId("composition-empty")).toHaveCount(3);
    await expect(card.locator('[data-entity="src"]').getByTestId("code-pane")).toContainText("x = 1 + 2");
    await card.getByTestId("composition-seek").selectOption({ label: "Step 4: compile" });
    // Groups keep their declared order, whatever order the step's placements were written in.
    await expect(card.getByTestId("composition-group").locator("h4")).toHaveText(["Source", "Tokens", "AST", "Bytecode"]);
    await expect(card.locator('[data-entity="ast"] [data-testid="composition-math"] .katex-display')).toBeVisible();
    await expect(card.locator('[data-entity="ast"] [data-testid="composition-text"] .katex')).toBeVisible();
    await expect(card.locator('[data-entity="bytecode"]').getByTestId("composition-reference")).toHaveText(["→refers to Assign node· , as compiled from"]);
    await expect(card.locator('[data-entity="bytecode"]').getByTestId("code-line")).toHaveCount(2);
  });

  test("rich content stays inside the card at 320px, in both themes, with malformed maths readable", async ({ page }) => {
    const { cards } = await showCompositions(page, "compositionrich");
    const card = cards.first();
    const owner = card.locator('[data-entity="owner"]');
    // Literal values: dollars stay text, "" shows, and the two parallel references are both chips.
    await expect(owner.getByTestId("composition-property")).toHaveCount(6);
    await expect(owner).toContainText("$10, not maths");
    await expect(owner.locator(".katex")).toHaveCount(0);
    await expect(owner).toContainText('""');
    await expect(owner.getByTestId("composition-reference")).toHaveText(["→refers to An entity label of 32 characters· , as owns", "→refers to An entity label of 32 characters· , as edits"]);
    // An unknown language is just a label, and a formula KaTeX can't parse shows its source.
    await expect(card.locator('[data-entity="listing"]').getByTestId("code-pane")).toContainText("COBOL-85 dialect");
    await expect(card.locator('[data-entity="listing"]').getByTestId("code-line")).toHaveCount(12);
    await expect(card.locator('[data-entity="formulas"]').getByTestId("composition-math").first()).toContainText("\\frac{1}{");
    await expect(card.locator('[data-entity="formulas"] .katex-display')).toHaveCount(1);

    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
        for (const at of ["0", "1", "2", "3"]) {
          await card.getByTestId("composition-seek").selectOption(at);
          await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(0);
          const box = (await card.boundingBox())!;
          for (const entity of await card.getByTestId("composition-entity").all()) {
            const inner = (await entity.boundingBox())!;
            expect(inner.x).toBeGreaterThanOrEqual(box.x - 0.5);
            expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
          }
        }
      }
    }
    // One column on a phone: groups stack.
    await page.setViewportSize({ width: 320, height: 900 });
    await card.getByTestId("composition-seek").selectOption("0");
    const [shelf, spare] = [await card.locator('[data-group="shelf"]').boundingBox(), await card.locator('[data-group="spare"]').boundingBox()];
    expect(shelf!.y + shelf!.height).toBeLessThanOrEqual(spare!.y);

    // Removing every property, then the declared ones come back at a later step.
    await card.getByTestId("composition-seek").selectOption("1");
    await expect(owner.getByTestId("composition-property")).toHaveCount(0);
    await expect(owner).toHaveAttribute("data-tone", "muted");
    await expect(card.getByTestId("composition-changes")).toContainText("owner loses a.");
    await expect(card.getByTestId("composition-changes")).toContainText("An entity label of 32 characters gains pages = 3.");
    // Everything hidden: both groups stay, empty.
    await card.getByTestId("composition-seek").selectOption("2");
    await expect(card.getByTestId("composition-entity")).toHaveCount(0);
    await expect(card.getByTestId("composition-empty")).toHaveCount(2);
    await card.getByTestId("composition-seek").selectOption("3");
    await expect(owner.getByTestId("composition-property")).toHaveCount(6);
  });

  test("the keyboard steps only the focused card, and a reload keeps both cards", async ({ page }) => {
    const { prompt, cards } = await showCompositions(page, "compositiontwo");
    await expect(cards).toHaveCount(2);
    const [alias, loop] = [cards.nth(0), cards.nth(1)];
    await loop.focus();
    await page.keyboard.press("ArrowRight");
    await expect(loop.getByTestId("step-counter")).toHaveText("Step 2 of 4");
    await expect(alias.getByTestId("step-counter")).toHaveText("Step 1 of 4");
    await expect(loop).toBeFocused();
    // The step picker's own arrow keys choose one step, without also stepping the card a second time.
    await loop.getByTestId("composition-seek").focus();
    await page.keyboard.press("ArrowDown");
    await expect(loop.getByTestId("step-counter")).toHaveText("Step 3 of 4");
    await expect(alias.getByTestId("step-counter")).toHaveText("Step 1 of 4");

    await page.reload();
    await page.getByRole("button", { name: prompt }).click();
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Two names, one list");
    await expect(cards.nth(1)).toContainText("One turn of the event loop");
    await expect(cards.nth(1).getByTestId("step-counter")).toHaveText("Step 1 of 4");
  });

  test("a lesson shows a composition section, the tutor can insert one, and a finished lesson replays both", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("textbox", { name: "Learning goal" }).fill(`Python names placementcourse lessoncomposition ${Date.now()}`);
    await page.getByRole("button", { name: "Start" }).click();
    await page.getByRole("region", { name: "Placement question: derivative" }).getByRole("button", { name: "True" }).click();
    await page.getByRole("region", { name: "Placement question: limit" }).getByRole("button", { name: "Not sure" }).click();
    await page.getByRole("region", { name: "Anything else to add" }).getByRole("button", { name: "Skip" }).click();
    await expect(page.getByText("Your syllabus is ready.")).toBeVisible();
    await page.getByRole("region", { name: "Course" }).getByRole("button", { name: "Start lesson 1" }).click();

    const lesson = page.getByRole("article", { name: "What a limit is" });
    const alias = lesson.getByRole("region", { name: /Two names, one list/ });
    await expect(alias.getByTestId("step-counter")).toHaveText("Step 1 of 4");
    await alias.getByRole("button", { name: "Next" }).click();
    await expect(alias.locator('[data-entity="b"]')).toBeVisible();
    // Stepping isn't answering: the lesson still waits for its check.
    await expect(lesson.getByRole("button", { name: "Finish lesson" })).toBeDisabled();

    // The tutor makes a composition in the drawer and inserts it as a section.
    await page.keyboard.press("Control+k");
    const tutor = page.getByRole("dialog", { name: "Tutor" });
    await tutor.getByRole("textbox", { name: "Message" }).fill("insertcomposition please");
    await tutor.getByRole("button", { name: "Send" }).click();
    await expect(tutor.getByText("I added the event loop.")).toBeVisible();
    await expect(tutor.getByRole("region", { name: /One turn of the event loop/ })).toBeVisible();
    await page.keyboard.press("Escape");
    const inserted = lesson.getByRole("region", { name: /One turn of the event loop/ });
    await expect(inserted.getByTestId("composition-entity")).toHaveCount(3);

    await lesson.getByRole("region", { name: /^Check: limit/ }).getByRole("button", { name: /^0/ }).click();
    await lesson.getByRole("button", { name: "Finish lesson" }).click();
    await expect(lesson.getByText("Finished. This lesson won't change.")).toBeVisible();

    await page.reload();
    await page.locator("[data-session-id]").filter({ hasText: "Calculus for ML" }).first().click();
    await expect(alias.getByTestId("step-counter")).toHaveText("Step 1 of 4");
    await expect(inserted.getByTestId("step-counter")).toHaveText("Step 1 of 4");
    await inserted.getByRole("button", { name: "Next" }).click();
    await expect(inserted.getByTestId("composition-changes")).toContainText("Task queue is reordered");
    await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});
