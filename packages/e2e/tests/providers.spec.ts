import { expect, test } from "../fixtures.js";

// Keys are app-wide and this worker's other tests share the server, so the test leaves the OpenRouter key saved.
test("model provider keys: first-run setup, saving, checking and removing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Model providers" }).click();
  const panel = page.getByRole("dialog", { name: "Model providers" });
  const openrouter = panel.getByRole("region", { name: "OpenRouter" });
  await expect(openrouter.getByText("Saved · ends in WXYZ.")).toBeVisible();
  // The key itself never reaches the page.
  await expect(panel).not.toContainText("sk-or-e2e");

  // With no key anywhere, the panel opens by itself and says one is needed.
  await openrouter.getByRole("button", { name: "Remove" }).click();
  await expect(openrouter.getByText(/^Not set\./)).toBeVisible();
  await page.reload();
  await expect(panel.getByText(/needs a model provider before it can teach/)).toBeVisible();

  // Saving a key checks it straight away, and the field is cleared.
  await openrouter.getByLabel("OpenRouter API key").fill("sk-or-v1-new-key-1234ABCD");
  await openrouter.getByRole("button", { name: "Save" }).click();
  await expect(openrouter.getByText("The key works.")).toBeVisible();
  await expect(openrouter.getByText("Saved · ends in ABCD.")).toBeVisible();
  await openrouter.getByRole("button", { name: "Check" }).click();
  await expect(openrouter.getByText("The key works.")).toBeVisible();

  // Closing it and reloading: a key is set, so the panel stays closed.
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("button", { name: "New session" }).first()).toBeVisible();
  await expect(panel).toHaveCount(0);

  // Put back the key the other tests expect.
  await page.getByRole("button", { name: "Model providers" }).click();
  await openrouter.getByRole("button", { name: "Replace" }).click();
  await openrouter.getByLabel("OpenRouter API key").fill("sk-or-e2e-key-0000WXYZ");
  await openrouter.getByRole("button", { name: "Save" }).click();
  await expect(openrouter.getByText("Saved · ends in WXYZ.")).toBeVisible();
});
