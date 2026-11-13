import { expect, test } from "../fixtures.js";

// Settings → Connect a CLI (ADR-016): the command and token `mivra link --server` needs on another computer.
test("Settings shows how to connect a CLI, with the token hidden until asked for", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const pageToken = await page.locator('meta[name="mivra-token"]').getAttribute("content");
  expect(pageToken).toBeTruthy();
  await page.getByRole("button", { name: "Settings" }).click();
  const panel = page.getByRole("dialog", { name: "Settings" });
  const section = panel.getByRole("region", { name: "Connect a CLI" });
  const origin = new URL(page.url()).origin;
  await expect(section.getByTestId("cli-link-command")).toHaveText(`mivra link --server ${origin}`);
  // This page is on loopback, which another computer can't reach.
  await expect(section).toContainText("Other computers can't reach this address");

  const field = section.getByRole("textbox", { name: "Token" });
  await expect(field).toHaveAttribute("type", "password");
  await section.getByRole("button", { name: "Show token" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue(pageToken!);
  await section.getByRole("button", { name: "Hide token" }).click();
  await expect(field).toHaveAttribute("type", "password");

  await section.getByRole("button", { name: "Copy token" }).click();
  await expect(section.getByRole("button", { name: "Copied token" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pageToken);
  await section.getByRole("button", { name: "Copy link command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`mivra link --server ${origin}`);
});
