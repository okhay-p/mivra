import { z } from "zod";
import { DistillationView } from "./knowledge.js";

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
    /** Distilling its notes into concepts and memories, which starts after every import (ADR-014). */
    distillation: DistillationView,
  })
  .strict();
export type VaultImportView = z.infer<typeof VaultImportView>;

/**
 * Why a file wasn't imported. `too_long` is a note over MAX_NOTE_CHARS and `symlink` a link inside a zipped
 * vault; both are reported by the zip upload and by clients that check sizes before sending.
 */
export const SkipReason = z.enum(["not_markdown", "hidden", "bad_path", "duplicate", "too_long", "symlink"]);
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

/** Most notes a graph view draws whole; an import (or filter) with more opens on the local graph instead. */
export const WHOLE_GRAPH_NOTES = 500;
/** Most notes, nodes and edges one graph view sends, whatever its mode, so a 10,000-note vault stays drawable. */
export const MAX_GRAPH_VIEW_NOTES = 500;
export const MAX_GRAPH_VIEW_NODES = 1_000;
export const MAX_GRAPH_VIEW_EDGES = 5_000;
/** Most tags and folders a graph view lists for its filters. */
export const MAX_GRAPH_FACETS = 200;

export const NoteGraphViewQuery = z
  .object({
    /** `auto` draws the whole graph when at most WHOLE_GRAPH_NOTES notes match, and the local graph otherwise. */
    mode: z.enum(["auto", "local"]).default("auto"),
    /** The note the local graph is drawn around. Defaults to the matching note with the most connections. */
    focus: z.string().max(64).optional(),
    /** How many hops from the focus the local graph reaches. Sharing a tag or concept is one hop, as a link is. */
    depth: z.coerce.number().int().min(1).max(3).default(2),
    /** Only notes carrying this tag, or one nested under it (`maths` matches `maths/algebra`). */
    tag: z.string().max(200).optional(),
    /** Only notes in this folder or below it, without a trailing `/`. */
    folder: z.string().max(512).optional(),
  })
  .strict();
export type NoteGraphViewQuery = z.infer<typeof NoteGraphViewQuery>;

export const NoteGraphNodeKind = z.enum(["note", "ghost", "tag", "concept"]);
export type NoteGraphNodeKind = z.infer<typeof NoteGraphNodeKind>;
export const NoteGraphEdgeKind = z.enum(["link", "tag", "concept", "prerequisite", "related"]);
export type NoteGraphEdgeKind = z.infer<typeof NoteGraphEdgeKind>;

/**
 * What a graph view of an import draws (ADR-014): notes, unresolved links as ghosts, and the tags and concepts that
 * connect notes. A note's `id` is the note's id; the other kinds' ids are prefixed (`tag:`, `concept:`, `ghost:`).
 * `notes` counts the matching notes a tag or concept connects, drawn or not,, and `hops` how far a node is from the focus.
 */
export const NoteGraphView = z
  .object({
    mode: z.enum(["whole", "local"]),
    focus: z.string().nullable(),
    depth: z.number().int(),
    totalNotes: z.number().int(),
    /** Notes matching the filters, drawn or not. */
    matchingNotes: z.number().int(),
    /** Whether the limits left matching nodes or edges out of the drawing. */
    truncated: z.boolean(),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          kind: NoteGraphNodeKind,
          label: z.string(),
          path: z.string().optional(),
          notes: z.number().int().optional(),
          hops: z.number().int().optional(),
        })
        .strict(),
    ),
    edges: z.array(z.object({ from: z.string(), to: z.string(), kind: NoteGraphEdgeKind }).strict()),
    tags: z.array(z.object({ name: z.string(), notes: z.number().int() }).strict()),
    folders: z.array(z.object({ path: z.string(), notes: z.number().int() }).strict()),
  })
  .strict();
export type NoteGraphView = z.infer<typeof NoteGraphView>;

/** A note found by title or path, for picking one to centre the graph on. */
export const NoteSummary = z.object({ id: z.string(), title: z.string(), path: z.string() }).strict();
export type NoteSummary = z.infer<typeof NoteSummary>;
