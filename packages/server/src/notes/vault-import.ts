import { createHash } from "node:crypto";
import type { DistillationView, SkipReason, VaultFile, VaultImportResult } from "@mivra/protocol";
import { DuplicateImportName, type NoteStore, type PreparedNote, type VaultImportRow } from "../store/note-store.js";
import { isMivraGenerated, noteKey, parseNote } from "./parse.js";
import { resolveGraph } from "./resolve.js";
import { cleanVaultPath, type SkippedFile } from "./vault-path.js";

export { cleanVaultPath, resolveGraph, type SkippedFile };

/**
 * Turns the files a client sent into a snapshot of the vault and stores it (ADR-014). No model runs here: the
 * same files always give the same notes, links and tags.
 */

/** Most links and tags one request can write across all its notes, on top of each note's own limit. */
export const MAX_VAULT_LINKS = 200_000;
export const MAX_VAULT_TAGS = 100_000;
/** How many skipped paths a result lists; the rest are only counted. */
const MAX_SKIPPED_LISTED = 20;

export type ImportOutcome =
  | { ok: true; result: VaultImportResult }
  | { ok: false; kind: "duplicate_name" | "not_found"; message: string };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function importView(row: VaultImportRow, distillation: DistillationView): VaultImportResult["import"] {
  return { id: row.id, name: row.name, source: row.source, noteCount: row.noteCount, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), distillation };
}

/** Called once a vault is stored: starts distilling its changed notes (ADR-014) and says where that stands. */
export type AfterImport = (importId: string) => DistillationView;

/** How long parsing runs before letting other requests (such as a streaming reply) through. */
const YIELD_EVERY_MS = 20;
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Sorts the files into notes to write, notes unchanged since the last import, and skipped paths. Parsing a large
 * vault takes seconds, so it pauses between notes to keep the server responsive.
 */
async function prepare(files: VaultFile[], previous: Map<string, string>) {
  let slice = performance.now();
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();
  const write: PreparedNote[] = [];
  const keep: string[] = [];
  let links = 0;
  let tags = 0;
  let truncated = false;
  for (const file of files) {
    if (performance.now() - slice > YIELD_EVERY_MS) {
      await yieldToEventLoop();
      slice = performance.now();
    }
    const cleaned = cleanVaultPath(file.path);
    if ("reason" in cleaned) {
      skipped.push({ path: file.path, reason: cleaned.reason });
      continue;
    }
    // Mivra's own export dropped into the vault (vault-export.ts): its files aren't the learner's notes.
    if (isMivraGenerated(file.text)) {
      skipped.push({ path: file.path, reason: "generated" });
      continue;
    }
    // Two paths that differ only in case are the same file on macOS and Windows.
    const key = cleaned.path.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ path: file.path, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    const hash = sha256(file.text);
    if (previous.get(cleaned.path) === hash) {
      keep.push(cleaned.path);
      continue;
    }
    const parsed = parseNote(cleaned.path, file.text);
    if (links + parsed.links.length > MAX_VAULT_LINKS) {
      parsed.links = parsed.links.slice(0, Math.max(0, MAX_VAULT_LINKS - links));
      parsed.truncated = true;
    }
    if (tags + parsed.tags.length > MAX_VAULT_TAGS) {
      parsed.tags = parsed.tags.slice(0, Math.max(0, MAX_VAULT_TAGS - tags));
      parsed.truncated = true;
    }
    links += parsed.links.length;
    tags += parsed.tags.length;
    truncated ||= parsed.truncated;
    write.push({
      path: cleaned.path,
      hash,
      body: file.text,
      titleKey: noteKey(parsed.title),
      aliasKeys: [...new Set(parsed.aliases.map(noteKey).filter(Boolean))],
      parsed,
    });
  }
  return { snapshot: { write, keep }, skipped, truncated };
}

/**
 * Starts a new import from a vault's files, or replaces an existing import's notes with them when `importId` is given.
 * `alreadySkipped` lists files a caller left out before this, such as a zip's attachments, to report with the rest.
 */
export async function importVault(
  store: NoteStore,
  input: { name: string; files: VaultFile[] } | { importId: string; files: VaultFile[] },
  alreadySkipped: SkippedFile[] = [],
  after: AfterImport,
): Promise<ImportOutcome> {
  const previous = "importId" in input ? store.noteHashes(input.importId) : new Map<string, string>();
  const { snapshot, skipped, truncated } = await prepare(input.files, previous);
  let stored;
  if ("importId" in input) {
    stored = store.replaceSnapshot(input.importId, snapshot);
    if (!stored) return { ok: false, kind: "not_found", message: "Import not found" };
  } else {
    try {
      stored = store.createImport(input.name, snapshot);
    } catch (error) {
      if (error instanceof DuplicateImportName) return { ok: false, kind: "duplicate_name", message: error.message };
      throw error;
    }
  }
  return {
    ok: true,
    result: {
      import: importView(stored.row, after(stored.row.id)),
      added: stored.added,
      updated: stored.updated,
      removed: stored.removed,
      unchanged: snapshot.keep.length,
      skippedCount: skipped.length + alreadySkipped.length,
      // Attachments and Mivra's own exported files are the least surprising, so they're listed last.
      skipped: [
        ...skipped.filter((f) => f.reason !== "generated"),
        ...alreadySkipped.filter((f) => f.reason !== "not_markdown"),
        ...alreadySkipped.filter((f) => f.reason === "not_markdown"),
        ...skipped.filter((f) => f.reason === "generated"),
      ].slice(0, MAX_SKIPPED_LISTED),
      truncated,
    },
  };
}
