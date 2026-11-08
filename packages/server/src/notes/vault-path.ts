import type { SkipReason } from "@mivra/protocol";

// Kept apart from the importer so the zip subprocess (vault-zip.ts) can check paths without loading the database code.

export type SkippedFile = { path: string; reason: SkipReason };

/**
 * A safe vault path, or why the file is skipped. Paths come from the client, so absolute paths, `..`, empty
 * segments and NUL are refused outright. Hidden folders such as `.obsidian` and `.trash` hold config and
 * deleted notes, not notes.
 */
export function cleanVaultPath(raw: string): { path: string } | { reason: SkipReason } {
  let path = raw.replace(/\\/g, "/").normalize("NFC");
  if (path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { reason: "bad_path" };
  path = path.replace(/^(\.\/)+/, "");
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return { reason: "bad_path" };
  if (segments.some((s) => s.startsWith("."))) return { reason: "hidden" };
  if (!/\.md$/i.test(path)) return { reason: "not_markdown" };
  return { path };
}
