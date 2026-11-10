import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { expect, test } from "../fixtures.js";

/** Reads a zip's entries through its central directory: enough for the export, which stores or deflates each one. */
function readZip(bytes: Buffer): Map<string, string> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const skip = nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const local = bytes.readUInt32LE(at + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    at += 46 + skip;
  }
  return files;
}

test.describe("exporting to Obsidian", () => {
  test.setTimeout(120_000);

  test("downloads a Mivra folder of concepts and memories that link to the learner's notes", async ({ page }) => {
    const stamp = Date.now();
    const name = `Exported ${stamp}`;
    const topic = `Topic${stamp}`;
    const root = mkdtempSync(join(tmpdir(), "mivra-vault-"));
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, `${topic}.md`), `#cs All about ${topic}.`);
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Imported notes" }).click();
      const panel = page.getByRole("dialog", { name: "Imported notes" });
      await panel.getByRole("button", { name: "Import a vault" }).click();
      const dialog = page.getByRole("dialog", { name: "Import an Obsidian vault" });
      await dialog.getByTestId("vault-folder-input").setInputFiles(join(root, name));
      await dialog.getByRole("button", { name: "Import", exact: true }).click();
      await expect(dialog.getByText(`Imported ${name}: 1 note in all.`)).toBeVisible();
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(panel.getByRole("listitem", { name }).getByText("1 concept and 1 memory drawn from these notes", { exact: false })).toBeVisible();

      const downloading = page.waitForEvent("download");
      await panel.getByRole("button", { name: "Export to Obsidian" }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toMatch(/^Mivra-\d{4}-\d{2}-\d{2}\.zip$/);
      await expect(panel.getByText(`Downloaded ${download.suggestedFilename()}.`, { exact: false })).toBeVisible();

      const files = readZip(readFileSync(await download.path()));
      expect(files.get("Mivra/Mivra.md")).toContain("mivra: generated");
      const concept = files.get(`Mivra/Concepts/${topic}.md`);
      expect(concept).toContain("mivra: generated");
      expect(concept).toContain(`- [[${topic}]]`);
      const memory = files.get(`Mivra/Memories/Known - Has notes on ${topic}.md`);
      expect(memory).toContain("kind: known");
      expect(memory).toContain(`source: "[[${topic}]]"`);
      expect(memory).toContain(`- Concept: [[Mivra/Concepts/${topic}|${topic}]]`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
