import { expect, test } from "../fixtures.js";

test("one graded answer continues exactly once without a learner bubble, even after retry and reload", async ({ page, request }) => {
  const title = `teach continuation ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(title);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const check = page.getByRole("region", { name: /^Check:/ });
  const answer = check.getByRole("button", { name: /^One$/ });
  await expect(answer).toBeEnabled();
  const before = (await (await request.get("/e2e/state")).json()).runs.length;
  const graded = page.waitForRequest(r => r.url().endsWith("/attempts"));
  await answer.click();
  const original = await graded;
  // A lost response or a second tab can retry the same answer; neither may double-grade or run.
  const retries = await Promise.all([page.request.fetch(original), page.request.fetch(original)]);
  expect(retries.map(r => r.status())).toEqual([409, 409]);
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("my unfinished thought");
  await input.focus();
  await expect(page.getByText("Lesson continued after correct.")).toBeVisible();
  await expect(input).toHaveValue("my unfinished thought");
  await expect(input).toBeFocused();
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
  await expect(check.getByText("Correct!", { exact: true })).toBeVisible();
  const after = (await (await request.get("/e2e/state")).json()).runs.length;
  expect(after - before).toBe(1);
  const other = await page.context().newPage();
  await other.goto("/");
  await other.getByRole("button", { name: title, exact: true }).click();
  await expect(other.getByText("Lesson continued after correct.")).toHaveCount(1);
  await other.close();
  await page.reload();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByText("Lesson continued after correct.")).toHaveCount(1);
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  // Let the one completion reconciliation settle, then observe more than two old idle intervals.
  await page.waitForTimeout(250);
  const idleRequests: string[] = [];
  page.on("request", r => { if (r.url().includes("/api/")) idleRequests.push(r.url()); });
  await page.waitForTimeout(1400);
  expect(idleRequests, "No timer may issue API requests while the session is idle").toEqual([]);
  expect((await (await request.get("/e2e/state")).json()).runs.length).toBe(after);
});

async function startQuiz(page: import("@playwright/test").Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill(title);
  const chat = page.waitForRequest(r => r.url().endsWith("/chat"));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sessionId = new URL((await chat).url()).pathname.split("/").at(-2)!;
  await expect(page.getByRole("region", { name: /^Check:/ }).getByRole("button", { name: /^One$/ })).toBeEnabled();
  return sessionId;
}

test("lost grading response and a dropped stream recover on focus without changing the draft", async ({ page, request }) => {
  await startQuiz(page, `teach continuationlive ${Date.now()}`);
  await page.setViewportSize({ width: 320, height: 640 });
  // Save the answer server-side, then lose its HTTP response.
  await page.route("**/attempts", async route => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: /^One$/ }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByText("Correct!", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("still drafting");
  await input.focus();
  // A phone may retain a stalled fetch after losing its network. Focus must replace it.
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  const resumed = page.waitForResponse(r => r.url().endsWith("/continuation"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await resumed).status()).toBe(200);
  await page.getByRole("button", { name: /^Thinking/ }).last().click();
  await expect(page.getByText("Considering", { exact: false })).toBeVisible();
  const transcript = page.getByTestId("transcript");
  await transcript.focus();
  await page.keyboard.press("Home");
  await input.focus();
  await request.post("/e2e/release");
  // The reply grows below a learner who scrolled up; it must not pull them down.
  await expect(page.getByText("The explanation is ready.", { exact: true })).toBeAttached();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(input).toHaveValue("still drafting");
  await expect(input).toBeFocused();
  expect(await transcript.evaluate(e => e.scrollTop)).toBe(0);
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
});

test("a late tab streams the continuation and Stop saves it as cancelled", async ({ page, request }) => {
  const title = `teach continuationstop ${Date.now()}`;
  await startQuiz(page, title);
  await page.getByRole("button", { name: /^One$/ }).click();
  await expect(page.getByText("Here is the part already explained.")).toBeVisible();
  const other = await page.context().newPage();
  await other.goto("/");
  await other.getByRole("button", { name: title, exact: true }).click();
  await expect(other.getByText("Here is the part already explained.")).toBeVisible();
  await other.getByRole("textbox", { name: "Message" }).fill("keep this draft");
  await expect(other.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await other.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(other.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(other.getByText("Correct!", { exact: true })).toBeVisible();
  await expect(other.getByRole("textbox", { name: "Message" })).toHaveValue("keep this draft");
  await expect.poll(async () => (await (await request.get("/e2e/state")).json()).runs.at(-1).status).toBe("cancelled");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(other.getByText("Here is the part already explained.")).toBeVisible();
  await other.close();
});

test("a failed continuation shows the normal error and keeps the grade", async ({ page, request }) => {
  await startQuiz(page, `teach continuationbroken ${Date.now()}`);
  await page.getByRole("button", { name: /^One$/ }).click();
  await expect(page.getByText("The model request failed.", { exact: true })).toBeVisible();
  await expect(page.getByText("Correct!", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/e2e/state")).json()).runs.at(-1).status).toBe("failed");
  expect(await page.locator("body").textContent()).not.toContain("PRIVATE-PROVIDER-SOCKET");
});


test("a socket failure with zero subscribers survives and is visible on the next focus check", async ({ page, request }) => {
  const id = await startQuiz(page, `teach continuationbroken unattended ${Date.now()}`);
  const artifact = page.getByRole("region", { name: /^Check:/ });
  // Submit directly: this tab never receives the attempt response or subscribes.
  const token = await page.locator('meta[name="mivra-token"]').getAttribute("content");
  const headers = { Authorization: `Bearer ${token}` };
  const messages = await (await request.get(`/api/sessions/${id}/messages`, { headers })).json();
  const part = messages.flatMap((m: { parts: { type: string; data?: { id: string; kind: string } }[] }) => m.parts).find((p: { type: string; data?: { kind: string } }) => p.type === "data-artifact" && p.data?.kind === "multiple_choice");
  expect((await request.post(`/api/artifacts/${part.data.id}/attempts`, { headers, data: { answer: { optionIndex: 1 } } })).status()).toBe(201);
  await expect.poll(async () => (await (await request.get("/e2e/state")).json()).runs.at(-1).status).toBe("failed");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("The model request failed.", { exact: true })).toBeVisible();
  await expect(artifact.getByText("Correct!", { exact: true })).toBeVisible();
  expect((await request.get("/api/health")).status()).toBe(200);
});
