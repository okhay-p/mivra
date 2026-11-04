import { expect, test } from "../fixtures.js";

// The selection is app-wide, and this worker's other tests share the server, so the test puts it back at the end.
test("switching the model and effort applies to the next reply, which names its model", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  const picker = page.getByRole("button", { name: /^Model: / });
  await expect(picker).toHaveAccessibleName("Model: scripted. Change model");
  // The default model can't be asked to reason, so there's no effort control.
  await expect(page.getByRole("button", { name: /^Reasoning effort/ })).toHaveCount(0);

  await picker.click();
  // Before the learner has many models of their own, the list suggests some.
  await expect(page.getByRole("group", { name: "Suggested" }).getByRole("option")).toHaveText([/E2E: Thinker/, /E2E: Plain/]);
  await page.getByRole("option", { name: /E2E: Thinker/ }).click();
  await expect(picker).toHaveAccessibleName("Model: Thinker. Change model");
  await page.getByRole("button", { name: /^Reasoning effort/ }).click();
  await expect(page.getByRole("menuitemradio")).toHaveText(["Default (Medium)", "Low", "Medium", "High"]);
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect(page.getByRole("button", { name: "Reasoning effort: High. Change effort" })).toBeVisible();

  await page.getByRole("textbox", { name: "Message" }).fill("whateffort for the picker");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const reply = page.locator("[data-message-role=assistant]").last();
  await expect(reply).toContainText("Effort reached me: high.");
  await expect(reply.locator("[data-reply-model]")).toHaveText("Thinker");
  const state = await (await request.get("/e2e/state")).json();
  expect(state.runs.at(-1)).toMatchObject({ model: "openrouter:e2e/thinker", effort: "high", status: "completed" });

  // The label comes back from the server after a reload, and the picker keeps the selection.
  await page.reload();
  await page.getByRole("button", { name: "whateffort for the picker", exact: true }).click();
  await expect(page.locator("[data-reply-model]").last()).toHaveText("Thinker");
  await expect(picker).toHaveAccessibleName("Model: Thinker. Change model");

  // Search reaches models the short list doesn't show; the default model is always listed.
  await picker.click();
  await page.getByRole("combobox", { name: "Choose a model" }).fill("scripted");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: /mivra:scripted/ }).click();
  await expect(picker).toHaveAccessibleName("Model: scripted. Change model");
});
