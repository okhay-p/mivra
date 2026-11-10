import { expect, test } from "../fixtures.js";

// Usage is app-wide and this worker's other tests share the server, so the test clears it first and at the end.
test("the Usage page counts a reply, compares plan usage only on request, takes a custom price and clears", async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const panel = page.getByRole("dialog", { name: "Usage" });
  const open = async () => {
    await page.getByRole("button", { name: "Usage", exact: true }).click();
    await expect(panel).toBeVisible();
  };
  const clear = async () => {
    await open();
    const button = panel.getByRole("button", { name: "Clear usage history" });
    if (await button.isEnabled()) {
      await button.click();
      const confirm = page.getByRole("dialog", { name: "Clear usage history?" });
      await expect(confirm).toContainText("doesn't reset any provider's billing");
      await confirm.getByRole("button", { name: "Clear usage history" }).click();
      await expect(confirm).toBeHidden();
    }
    await expect(panel.getByText("Nothing recorded yet.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  };
  await clear();
  const completed = async () => (await (await request.get("/e2e/state")).json()).runs.filter((r: { status: string }) => r.status === "completed").length as number;
  const before = await completed();

  // One reply from the scripted model: 1 token in and 1 out, with no price, so its cost is unknown, not free.
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill("hello usage page");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(completed).toBe(before + 1);

  await open();
  const tokens = panel.getByRole("group", { name: "Tokens" });
  await expect(tokens).toContainText("2");
  await expect(tokens).toContainText("1 in · 1 out");
  await expect(panel.getByRole("group", { name: "API spending" })).toContainText("Unknown");
  await expect(panel.getByRole("group", { name: "API spending" })).toContainText("1 call unknown");
  await expect(panel.getByRole("group", { name: "ChatGPT plan" })).toContainText("Not used");
  await expect(panel.getByRole("link", { name: "Manage ChatGPT usage (opens in a new tab)" })).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  await expect(panel.getByRole("region", { name: "By activity" }).getByRole("rowheader", { name: /Chat replies/ })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Estimated API equivalent" })).toHaveCount(0);

  // A custom price applies from the next call; the recorded one stays unknown.
  await panel.getByRole("button", { name: "Advanced: custom prices" }).click();
  const price = panel.getByRole("group", { name: "mivra:scripted" });
  await price.getByRole("textbox", { name: /^Input price/ }).fill("100000");
  await price.getByRole("textbox", { name: /^Output price/ }).fill("100000");
  await price.getByRole("button", { name: "Save price" }).click();
  await expect(price.getByText("Custom price")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Message" }).fill("hello again");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(completed).toBe(before + 2);

  // A plan call: tokens billed to the plan, and an API comparison only when asked for, never added to spending.
  await request.post("/e2e/usage/plan-call");
  await open();
  await expect(panel.getByRole("group", { name: "API spending" })).toContainText("≈$0.20+");
  await expect(panel.getByRole("group", { name: "ChatGPT plan" })).toContainText("1.1M");
  const comparison = panel.getByRole("button", { name: "Estimated API equivalent" });
  await expect(panel.getByText("What these tokens would cost at published API rates.")).toBeHidden();
  await comparison.click();
  await expect(panel.getByText("What these tokens would cost at published API rates. This is not a charge or your subscription cost.")).toBeVisible();
  await expect(panel.getByText("≈$2.80")).toBeVisible();
  await expect(panel.getByRole("region", { name: "By model" }).getByRole("row", { name: /E2E Plan/ })).toContainText("ChatGPT plan");

  // Clean up: the custom price and the history.
  await panel.getByRole("button", { name: "Advanced: custom prices" }).click();
  await price.getByRole("button", { name: "Remove" }).click();
  await expect(price.getByText("Custom price")).toBeHidden();
  await page.keyboard.press("Escape");
  await clear();
});
