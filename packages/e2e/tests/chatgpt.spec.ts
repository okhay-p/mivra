import { expect, test } from "../fixtures.js";

// The sign-in is app-wide and this worker's other tests share the server, so the test disconnects at the end.
test("sign in with ChatGPT: the browser goes to ChatGPT, comes back, and the plan is welcomed once", async ({ page, context, baseURL }) => {
  // Stand in for auth.openai.com: approving sends the browser back to Mivra's callback, as OpenAI does.
  await context.route("https://auth.openai.com/**", async (route) => {
    const approve = await fetch(`${baseURL}/e2e/chatgpt/approve?url=${encodeURIComponent(route.request().url())}`);
    await route.fulfill({ status: 302, headers: { location: await approve.text() } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Model providers" }).click();
  const panel = page.getByRole("dialog", { name: "Model providers" });
  const chatgpt = panel.getByRole("region", { name: "ChatGPT" });
  if (process.env.MIVRA_E2E_SHOTS) await chatgpt.screenshot({ path: "/tmp/claude-1000/-home-oakkar-Projects-mivra-harness/9b7366ef-6db9-441a-806d-5c437dab0969/scratchpad/shot-signed-out.png" });

  const [tab] = await Promise.all([context.waitForEvent("page"), chatgpt.getByRole("button", { name: "Continue with ChatGPT" }).click()]);
  await expect(tab.getByRole("heading", { name: "Signed in to ChatGPT" })).toBeVisible();
  await tab.close();
  await expect(chatgpt.getByText("learner@example.com")).toBeVisible();
  await expect(chatgpt.getByText("Connected", { exact: true })).toBeVisible();

  // OpenAI's guidelines: a one-time welcome the first time the learner signs in.
  const welcome = page.getByRole("dialog", { name: "You're using your ChatGPT plan" });
  await expect(welcome).toBeVisible();
  if (process.env.MIVRA_E2E_SHOTS) await page.screenshot({ path: "/tmp/claude-1000/-home-oakkar-Projects-mivra-harness/9b7366ef-6db9-441a-806d-5c437dab0969/scratchpad/shot-welcome.png" });
  await welcome.getByRole("button", { name: "Got it" }).click();
  await expect(welcome).toHaveCount(0);
  if (process.env.MIVRA_E2E_SHOTS) await chatgpt.screenshot({ path: "/tmp/claude-1000/-home-oakkar-Projects-mivra-harness/9b7366ef-6db9-441a-806d-5c437dab0969/scratchpad/shot-connected.png" });

  await chatgpt.getByRole("button", { name: "Disconnect" }).click();
  await expect(chatgpt.getByText("Signs in as learner@example.com.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "You're using your ChatGPT plan" })).toHaveCount(0);
});
