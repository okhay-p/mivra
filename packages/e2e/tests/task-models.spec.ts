import { expect, test } from "../fixtures.js";

// Settings are app-wide and this worker's other tests share the server, so the test resets the override at the end.
test("lesson generation follows the main model until overridden in Settings, and resets to it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const panel = page.getByRole("dialog", { name: "Settings" });
  const row = panel.getByRole("group", { name: "Lesson generation" });
  await expect(row.getByText("Uses main model")).toBeVisible();
  await expect(row).toContainText("Follows the main model, now scripted");
  await expect(row.getByRole("button", { name: "Use main model" })).toHaveCount(0);

  await row.getByRole("button", { name: "Lesson model: scripted. Change model" }).click();
  await page.getByRole("option", { name: /E2E: Thinker/ }).click();
  await expect(row.getByText("Own model")).toBeVisible();
  await row.getByRole("button", { name: /^Lesson model reasoning effort/ }).click();
  // Only the efforts this model supports are offered.
  await expect(page.getByRole("menuitemradio")).toHaveText(["Default (Medium)", "Low", "Medium", "High"]);
  await page.getByRole("menuitemradio", { name: "Low" }).click();
  await expect(row.getByRole("button", { name: "Lesson model reasoning effort: Low. Change effort" })).toBeVisible();

  // The override survives a reload, and the main picker is unchanged.
  await page.reload();
  await page.getByRole("button", { name: "New session" }).first().click();
  await expect(page.getByRole("button", { name: /^Model: / })).toHaveAccessibleName("Model: scripted. Change model");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(row.getByRole("button", { name: "Lesson model: Thinker. Change model" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Lesson model reasoning effort: Low. Change effort" })).toBeVisible();

  await row.getByRole("button", { name: "Use main model" }).click();
  await expect(row.getByText("Uses main model")).toBeVisible();
  await expect(row.getByRole("button", { name: "Lesson model: scripted. Change model" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
