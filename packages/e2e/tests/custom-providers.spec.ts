import { expect, test } from "../fixtures.js";

// Providers and the model selection are app-wide, and this worker's other tests share the server, so the test removes
// its provider and goes back to the scripted model at the end.
test("custom OpenAI-compatible provider: add, test, select, chat, edit and remove", async ({ page, request, baseURL }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("button", { name: "Model providers" }).click();
  const panel = page.getByRole("dialog", { name: "Model providers" });

  // Add it with its URL and key; its own model list loads straight away.
  await panel.getByRole("button", { name: "Add an OpenAI-compatible provider" }).click();
  const form = panel.getByRole("form", { name: "Add an OpenAI-compatible provider" });
  await form.getByLabel("Provider name").fill("Local Fake");
  await form.getByLabel("API base URL").fill(`${baseURL}/e2e/compat/v1/`);
  await form.getByLabel("API key").fill("sk-fake-e2e-key-0000FAKE");
  await form.getByRole("button", { name: "Save provider" }).click();
  const card = panel.getByRole("region", { name: "Local Fake" });
  await expect(card.getByText(`${baseURL}/e2e/compat/v1 · saved`)).toBeVisible();
  await expect(card.getByText("Key saved · ends in FAKE.")).toBeVisible();
  await expect(card.getByText("The provider lists 2 models.", { exact: false })).toBeVisible();
  await expect(panel).not.toContainText("sk-fake-e2e");

  // Add a model by its id, then test it: streamed tool calling and continuing after the result.
  await card.getByLabel("Add a model id").fill("fake-chat");
  await card.getByRole("button", { name: "Add", exact: true }).click();
  const model = card.getByRole("listitem", { name: "fake-chat" });
  await expect(model.getByText("Not tested")).toBeVisible();
  await model.getByRole("button", { name: "Test model fake-chat" }).click();
  await expect(model.getByText("Streaming, tool calling and continuing after a tool result all work.")).toBeVisible();
  await expect(model.getByText("Works")).toBeVisible();
  await page.keyboard.press("Escape");

  // It shows under its provider in the picker, and replies come from its endpoint.
  const picker = page.getByRole("button", { name: /^Model: / });
  await picker.click();
  await page.getByRole("group", { name: "Local Fake" }).getByRole("option", { name: /fake-chat/ }).click();
  await expect(picker).toHaveAccessibleName("Model: fake-chat (Local Fake). Change model");
  await page.getByRole("textbox", { name: "Message" }).fill("Say hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const reply = page.locator("[data-message-role=assistant]").last();
  await expect(reply).toContainText("Hello from the fake (fake-chat).");
  await expect(reply.locator("[data-reply-model]")).toHaveText("fake-chat (Local Fake)");
  const state = await (await request.get("/e2e/state")).json();
  expect(state.runs.at(-1)).toMatchObject({ model: "custom:local-fake/fake-chat", status: "completed" });
  // Only its own key went to it.
  const sent = (await (await request.get("/e2e/compat-requests")).json()) as { authorization: string | null }[];
  expect(sent.every((r) => r.authorization === "Bearer sk-fake-e2e-key-0000FAKE")).toBe(true);

  // Renaming keeps the model's identity: the selection and the reply's label follow the new name.
  await page.getByRole("button", { name: "Model providers" }).click();
  await card.getByRole("button", { name: "Edit" }).click();
  await panel.getByRole("form", { name: "Edit Local Fake" }).getByLabel("Provider name").fill("Renamed Fake");
  await panel.getByRole("form", { name: "Edit Local Fake" }).getByRole("button", { name: "Save", exact: true }).click();
  const renamed = panel.getByRole("region", { name: "Renamed Fake" });
  await expect(renamed).toBeVisible();
  // The test result still applies: the URL and key didn't change.
  await expect(renamed.getByRole("listitem", { name: "fake-chat" }).getByText("Works")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveAccessibleName("Model: fake-chat (Renamed Fake). Change model");

  // Removing it asks for another model instead of switching silently; the old reply still names its model.
  await page.getByRole("button", { name: "Model providers" }).click();
  await renamed.getByRole("button", { name: "Remove provider" }).click();
  await renamed.getByRole("button", { name: "Yes, remove" }).click();
  await expect(renamed).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert").filter({ hasText: "The provider Renamed Fake was removed. Choose another model" })).toBeVisible();
  await expect(reply).toContainText("Hello from the fake (fake-chat).");
  await expect(reply.locator("[data-reply-model]")).toHaveText("fake-chat (Renamed Fake)");

  await picker.click();
  await page.getByRole("combobox", { name: "Choose a model" }).fill("scripted");
  await page.getByRole("option", { name: /mivra:scripted/ }).click();
  await expect(picker).toHaveAccessibleName("Model: scripted. Change model");
  await expect(page.getByRole("alert").filter({ hasText: "was removed" })).toHaveCount(0);
});
