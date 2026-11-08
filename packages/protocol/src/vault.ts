import { z } from "zod";

/**
 * Importing a learner's Obsidian vault (ADR-014). A vault is hostile input (ADR-010), so every size is capped.
 * Clients send only Markdown files; the server checks each path again and skips anything else.
 */

/** Most files one import can send. */
export const MAX_VAULT_FILES = 10_000;
/** Longest note, in characters. */
export const MAX_NOTE_CHARS = 1_000_000;
/** Largest import request body. */
export const MAX_VAULT_BYTES = 64 * 1024 * 1024;
const MAX_PATH_CHARS = 512;

export const VaultFile = z
  .object({
    /** The file's path inside the vault, with `/` between folders, e.g. `Maths/Recursion.md`. */
    path: z.string().min(1).max(MAX_PATH_CHARS),
    text: z.string().max(MAX_NOTE_CHARS),
  })
  .strict();
export type VaultFile = z.infer<typeof VaultFile>;

const VaultFiles = z.array(VaultFile).max(MAX_VAULT_FILES);
const VaultName = z.string().trim().min(1).max(120);

/** Starts a new import. The name tells imports apart, so it's unique; the CLI defaults it to the vault folder's name. */
export const VaultImportInput = z.object({ name: VaultName, files: VaultFiles }).strict();
export type VaultImportInput = z.infer<typeof VaultImportInput>;

/** Replaces an import's files with a new snapshot of the vault. */
export const VaultSnapshotInput = z.object({ files: VaultFiles }).strict();
export type VaultSnapshotInput = z.infer<typeof VaultSnapshotInput>;

export const VaultImportView = z
  .object({
    id: z.string(),
    name: z.string(),
    source: z.literal("obsidian"),
    noteCount: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type VaultImportView = z.infer<typeof VaultImportView>;

export const SkipReason = z.enum(["not_markdown", "hidden", "bad_path", "duplicate"]);
export type SkipReason = z.infer<typeof SkipReason>;

/** What one import or re-import changed. `skipped` lists at most a few paths; `skippedCount` counts them all. */
export const VaultImportResult = z
  .object({
    import: VaultImportView,
    added: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
    unchanged: z.number().int(),
    skippedCount: z.number().int(),
    skipped: z.array(z.object({ path: z.string(), reason: SkipReason }).strict()),
    /** Links or tags left out because a note or the vault had more than the limit. */
    truncated: z.boolean(),
  })
  .strict();
export type VaultImportResult = z.infer<typeof VaultImportResult>;

export const NoteView = z
  .object({
    id: z.string(),
    importId: z.string(),
    path: z.string(),
    title: z.string(),
    aliases: z.array(z.string()),
    tags: z.array(z.string()),
    body: z.string(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type NoteView = z.infer<typeof NoteView>;

/**
 * An import's notes and the links between them. A link whose target is no note in the vault has `to: null`
 * and keeps its `target`, so a client can draw it as an unresolved node, as Obsidian does.
 */
export const NoteGraph = z
  .object({
    notes: z.array(z.object({ id: z.string(), path: z.string(), title: z.string(), tags: z.array(z.string()) }).strict()),
    links: z.array(z.object({ from: z.string(), to: z.string().nullable(), target: z.string(), kind: z.enum(["link", "embed"]) }).strict()),
  })
  .strict();
export type NoteGraph = z.infer<typeof NoteGraph>;
