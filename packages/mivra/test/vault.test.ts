import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_NOTE_CHARS } from "@mivra/protocol";
import { VaultReadError, readVault } from "../src/vault.js";

const root = mkdtempSync(join(tmpdir(), "mivra-vault-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readVault", () => {
  it("reads Markdown notes, skipping hidden folders and notes over the size limit without loading them", () => {
    const vault = join(root, "v");
    mkdirSync(join(vault, ".trash"), { recursive: true });
    mkdirSync(join(vault, "Deep", "Er"), { recursive: true });
    writeFileSync(join(vault, "A.md"), "a");
    writeFileSync(join(vault, "Deep", "Er", "B.MD"), "b");
    writeFileSync(join(vault, "image.png"), "x");
    writeFileSync(join(vault, ".trash", "old.md"), "gone");
    writeFileSync(join(vault, "Huge.md"), Buffer.alloc(MAX_NOTE_CHARS * 4 + 1, 97));
    writeFileSync(join(vault, "Long.md"), "x".repeat(MAX_NOTE_CHARS + 1));
    const { files, tooLong } = readVault(vault);
    expect(files).toEqual([{ path: "A.md", text: "a" }, { path: "Deep/Er/B.MD", text: "b" }]);
    expect(tooLong.sort()).toEqual(["Huge.md", "Long.md"]);
  });

  it("refuses a path that isn't a folder", () => {
    writeFileSync(join(root, "file.md"), "x");
    expect(() => readVault(join(root, "file.md"))).toThrow(VaultReadError);
    expect(() => readVault(join(root, "missing"))).toThrow(VaultReadError);
  });
});
