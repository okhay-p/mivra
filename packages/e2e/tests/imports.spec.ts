import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "../fixtures.js";
import { makeZip } from "../../server/test/support/files.js";

/** A vault folder on disk with these files, named so tests sharing a worker's database don't collide. */
function makeVault(name: string, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "mivra-vault-"));
  const vault = join(root, name);
  const write = (entries: Record<string, string>) => {
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(vault, path)), { recursive: true });
      writeFileSync(join(vault, path), text);
    }
  };
  write(files);
  return { path: vault, write, remove: () => rmSync(root, { recursive: true, force: true }) };
}

async function openImports(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Imported notes" }).click();
  return page.getByRole("dialog", { name: "Imported notes" });
}

// The zip is unpacked in a subprocess the harness starts through tsx, which takes seconds on a busy machine.
const UNPACK = { timeout: 45_000 };

test.describe("imported notes", () => {
  test.setTimeout(150_000);

  test("imports a vault folder, re-imports it, and deletes it", async ({ page }) => {
    const name = `Vault ${Date.now()}`;
    const vault = makeVault(name, {
      "Recursion.md": "See [[Stack]]. #cs",
      "Data/Stack.md": "Push and pop.",
      ".obsidian/app.json": "{}",
      "diagram.png": "png",
    });
    try {
      const panel = await openImports(page);
      await panel.getByRole("button", { name: "Import a vault" }).click();
      const dialog = page.getByRole("dialog", { name: "Import an Obsidian vault" });
      await dialog.getByTestId("vault-folder-input").setInputFiles(vault.path);
      await expect(dialog.getByText(`2 notes found in ${name}`)).toBeVisible();
      await expect(dialog.getByText("Left out: 1 other file.")).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Import name" })).toHaveValue(name);
      await dialog.getByRole("button", { name: "Import", exact: true }).click();
      await expect(dialog.getByText(`Imported ${name}: 2 notes in all.`)).toBeVisible();
      await dialog.getByRole("button", { name: "Done" }).click();

      const entry = panel.getByRole("listitem", { name });
      await expect(entry.getByText(/^2 notes · Updated/)).toBeVisible();

      vault.write({ "Recursion.md": "Changed. See [[Stack]].", "Queue.md": "First in, first out." });
      await entry.getByRole("button", { name: "Re-import" }).click();
      const again = page.getByRole("dialog", { name: `Re-import ${name}` });
      await again.getByTestId("vault-folder-input").setInputFiles(vault.path);
      await again.getByRole("button", { name: "Re-import" }).click();
      await expect(again.getByText(`Re-imported ${name}: 3 notes in all.`)).toBeVisible();
      const changes = again.getByLabel("What changed");
      await expect(changes).toContainText("Added1");
      await expect(changes).toContainText("Updated1");
      await expect(changes).toContainText("Unchanged1");
      await again.getByRole("button", { name: "Done" }).click();
      await expect(entry.getByText(/^3 notes · Updated/)).toBeVisible();

      await entry.getByRole("button", { name: "Delete" }).click();
      await entry.getByRole("button", { name: "Yes, delete" }).click();
      await expect(entry).toHaveCount(0);
      await page.reload();
      await page.getByRole("button", { name: "Imported notes" }).click();
      await expect(page.getByRole("dialog", { name: "Imported notes" }).getByText(name)).toHaveCount(0);
    } finally {
      vault.remove();
    }
  });

  test("imports a zipped vault, then re-imports it by name", async ({ page }) => {
    const name = `Zipped ${Date.now()}`;
    const zip = (files: Record<string, string>) => ({
      name: `${name}.zip`,
      mimeType: "application/zip",
      buffer: makeZip(Object.entries(files).map(([path, data]) => ({ name: `${name}/${path}`, data }))),
    });
    const panel = await openImports(page);
    await panel.getByRole("button", { name: "Import a vault" }).click();
    const dialog = page.getByRole("dialog", { name: "Import an Obsidian vault" });
    await expect(dialog.getByRole("button", { name: "Upload a .zip instead" })).toBeVisible();
    await dialog.getByTestId("vault-zip-input").setInputFiles(zip({ "One.md": "First note", "Two.md": "Second", "pic.png": "png" }));
    await expect(dialog.getByRole("textbox", { name: "Import name" })).toHaveValue(name);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog.getByText(`Imported ${name}: 2 notes in all.`)).toBeVisible(UNPACK);
    await expect(dialog.getByText("pic.png (not a note)")).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(panel.getByRole("listitem", { name }).getByText(/^2 notes/)).toBeVisible();

    // Importing under a name that's taken re-imports that vault.
    await panel.getByRole("button", { name: "Import a vault" }).click();
    await dialog.getByTestId("vault-zip-input").setInputFiles(zip({ "One.md": "First note" }));
    await expect(dialog.getByText(/already exists, so this re-imports it/)).toBeVisible();
    await dialog.getByRole("button", { name: "Re-import" }).click();
    await expect(page.getByText(`Re-imported ${name}: 1 note in all.`)).toBeVisible(UNPACK);
  });

  test("reads imported notes for concepts and memories, can cancel it, and deleting the import removes them", async ({ page }) => {
    const stamp = Date.now();
    const name = `Distilled ${stamp}`;
    const topic = `Topic${stamp}`;
    const vault = makeVault(name, { [`${topic}.md`]: `#cs All about ${topic}.`, "Slow/Later.md": "#zz slowdistil" });
    try {
      const panel = await openImports(page);
      await panel.getByRole("button", { name: "Import a vault" }).click();
      const dialog = page.getByRole("dialog", { name: "Import an Obsidian vault" });
      await dialog.getByTestId("vault-folder-input").setInputFiles(vault.path);
      await dialog.getByRole("button", { name: "Import", exact: true }).click();
      await expect(dialog.getByText(`Imported ${name}: 2 notes in all.`)).toBeVisible();
      await dialog.getByRole("button", { name: "Done" }).click();

      // The #cs group is read; the #zz group holds until it's cancelled.
      const entry = panel.getByRole("listitem", { name });
      await expect(entry.getByText("Reading notes for concepts… group 2 of 2")).toBeVisible();
      await expect(entry.getByRole("progressbar")).toBeVisible();
      await entry.getByRole("button", { name: "Cancel" }).click();
      await expect(entry.getByText("Cancelled. 1 note not read for concepts yet.")).toBeVisible();
      await expect(entry.getByText("So far: 1 concept and 1 memory drawn from these notes.")).toBeVisible();
      await expect(entry.getByRole("button", { name: "Resume" })).toBeVisible();

      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Memory", exact: true }).click();
      const memory = page.getByRole("dialog", { name: "Memory" });
      await expect(memory.getByText(`Has notes on ${topic}.`)).toBeVisible();
      await expect(memory.getByText(`From your note ${topic}`)).toBeVisible();
      await memory.getByRole("button", { name: "From notes" }).click();
      await expect(memory.getByRole("button", { name: "Delete all from notes" })).toBeVisible();
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Imported notes" }).click();
      const again = page.getByRole("dialog", { name: "Imported notes" }).getByRole("listitem", { name });
      await again.getByRole("button", { name: "Delete" }).click();
      await again.getByRole("button", { name: "Yes, delete" }).click();
      await expect(again).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Memory", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Memory" }).getByText(/^(No memories yet|Goals|Preferences|Misconceptions|Known from your notes)$/).first()).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Memory" }).getByText(`Has notes on ${topic}.`)).toHaveCount(0);
    } finally {
      vault.remove();
    }
  });
});
