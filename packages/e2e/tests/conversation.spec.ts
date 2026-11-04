import { expect, test } from "../fixtures.js";

test("scrolling up during streaming stays put and the scroll button resumes following", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.setViewportSize({ width: 320, height: 640 });
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("currencyblocks scroll regression");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const transcript = page.getByTestId("transcript");
  await expect.poll(() => transcript.evaluate(e => e.scrollTop)).toBeGreaterThan(500);
  await transcript.hover();
  await page.mouse.wheel(0, -400);
  const button = page.getByRole("button", { name: "Scroll to bottom" });
  await expect(button).toBeVisible();
  const top = await transcript.evaluate(e => e.scrollTop);
  const length = await transcript.innerText();
  await expect.poll(() => transcript.innerText()).not.toBe(length);
  await page.waitForTimeout(350);
  expect(Math.abs(await transcript.evaluate(e => e.scrollTop) - top)).toBeLessThan(3);
  // Keyboard scrolling must also leave following paused while more deltas arrive.
  await transcript.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => transcript.evaluate(e => e.scrollTop)).toBe(0);
  await page.waitForTimeout(350);
  expect(await transcript.evaluate(e => e.scrollTop)).toBe(0);
  await button.click();
  await expect(button).toBeHidden();
  await expect.poll(() => transcript.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(80);
  // Native touch scrolling takes a separate path from the library's wheel listener.
  const touch = await page.context().newCDPSession(page);
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 160, y: 180 }] });
  for (let y = 220; y <= 420; y += 40) {
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 160, y }] });
    await page.waitForTimeout(40);
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(button).toBeVisible();
  const touchedTop = await transcript.evaluate(e => e.scrollTop);
  const touchedText = await transcript.innerText();
  await expect.poll(() => transcript.innerText()).not.toBe(touchedText);
  await page.waitForTimeout(350);
  expect(await transcript.evaluate(e => e.scrollTop)).toBeLessThanOrEqual(touchedTop + 3);
  await button.click();
  await expect(button).toBeHidden();
  await touch.detach();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(await page.getByRole("main").evaluate(e => e.scrollTop)).toBe(0);
});
