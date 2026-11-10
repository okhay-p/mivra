import { randomUUID } from "node:crypto";
import { asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { noteChunks, noteLinks, noteTags, notes, vaultImports } from "../db/schema.js";
import type { ParsedNote } from "../notes/parse.js";
import { clearDistilled, detachMemories, dropUnsupportedConcepts } from "./knowledge-store.js";

export type VaultImportRow = typeof vaultImports.$inferSelect & { noteCount: number };
export type NoteRow = typeof notes.$inferSelect;
export type NoteLinkRow = typeof noteLinks.$inferSelect;
/** A chunk of a note matched by search, with what's needed to cite it. */
/** A matching chunk. `rank` is its FTS5 bm25 score for the query: negative, and lower is a better match. */
export type NoteExcerpt = { chunkId: number; noteId: string; importId: string; path: string; title: string; heading: string | null; seq: number; text: string; rank: number };

/** A note ready to store: its vault path, the hash of its text, and what parsing found. */
export interface PreparedNote {
  path: string;
  hash: string;
  body: string;
  titleKey: string;
  aliasKeys: string[];
  parsed: ParsedNote;
}

/** An import's whole new state: notes to write, and the paths of notes kept as they are. Every other note goes. */
export interface VaultSnapshot {
  write: PreparedNote[];
  keep: string[];
}

export class DuplicateImportName extends Error {}

/** SQLite's limit on bound parameters is far above this; it keeps each statement a sensible size. */
const BATCH = 500;
const batches = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH) }, (_, i) => items.slice(i * BATCH, (i + 1) * BATCH));

/**
 * Persistence for imported vaults and their notes (ADR-014). Like session-store.ts and lesson-store.ts, the only
 * code that talks to Drizzle about these tables (ADR-007).
 */
export function createNoteStore(db: Db, clock: () => Date = () => new Date()) {
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
  // Same connection as Drizzle's transactions, so these run inside them.
  const insertNote = db.$client.prepare(
    "insert into notes (id, import_id, path, title, title_key, aliases, body, hash, created_at, updated_at) values (@id, @importId, @path, @title, @titleKey, @aliases, @body, @hash, @now, @now)",
  );
  const insertChunk = db.$client.prepare("insert into note_chunks (note_id, seq, heading, text) values (@noteId, @seq, @heading, @text)");
  const insertLink = db.$client.prepare("insert into note_links (note_id, target, kind) values (@noteId, @target, @kind)");
  const insertTag = db.$client.prepare("insert into note_tags (note_id, tag) values (@noteId, @tag)");

  const withCount = (tx: Db | Tx, row: typeof vaultImports.$inferSelect): VaultImportRow => ({
    ...row,
    noteCount: tx.select({ value: count() }).from(notes).where(eq(notes.importId, row.id)).get()?.value ?? 0,
  });

  /**
   * Writes a snapshot inside a transaction. A rewritten note keeps its id, so references to it survive a re-import.
   * Rows go through statements prepared once: building a Drizzle query per row took seconds for a few thousand notes.
   */
  const applySnapshot = (tx: Tx, importId: string, snapshot: VaultSnapshot, now: Date) => {
    const existing = new Map(tx.select({ id: notes.id, path: notes.path }).from(notes).where(eq(notes.importId, importId)).all().map((n) => [n.path, n.id]));
    const present = new Set([...snapshot.keep, ...snapshot.write.map((n) => n.path)]);
    const gone = [...existing].filter(([path]) => !present.has(path)).map(([, id]) => id);
    for (const batch of batches(gone)) {
      // A memory other notes support too moves to one of them; the rest go with their note by cascade.
      detachMemories(tx, batch);
      tx.delete(notes).where(inArray(notes.id, batch)).run();
    }

    const written = snapshot.write.map((note) => ({ note, id: existing.get(note.path) ?? randomUUID(), isNew: !existing.has(note.path) }));
    // The note's new text has never been distilled, even if an earlier text with this hash was: what that yielded is
    // cleared below, so a stale hash would leave the note with nothing and never waiting.
    const values = (note: PreparedNote) => ({ title: note.parsed.title, titleKey: note.titleKey, aliases: note.aliasKeys, body: note.body, hash: note.hash, distilledHash: null, updatedAt: now });
    const rewritten = written.filter((w) => !w.isNew);
    // What the old text yielded goes with it, and the new text waits to be distilled; gone notes take theirs by cascade.
    clearDistilled(tx, rewritten.map((w) => w.id));
    for (const { note, id } of rewritten) tx.update(notes).set(values(note)).where(eq(notes.id, id)).run();
    for (const batch of batches(rewritten.map((w) => w.id))) {
      tx.delete(noteChunks).where(inArray(noteChunks.noteId, batch)).run();
      tx.delete(noteLinks).where(inArray(noteLinks.noteId, batch)).run();
      tx.delete(noteTags).where(inArray(noteTags.noteId, batch)).run();
    }
    for (const { note, id, isNew } of written) {
      if (isNew) insertNote.run({ id, importId, path: note.path, title: note.parsed.title, titleKey: note.titleKey, aliases: JSON.stringify(note.aliasKeys), body: note.body, hash: note.hash, now: now.getTime() });
      for (const chunk of note.parsed.chunks) insertChunk.run({ noteId: id, seq: chunk.seq, heading: chunk.heading, text: chunk.text });
      for (const link of note.parsed.links) insertLink.run({ noteId: id, target: link.target, kind: link.kind });
      for (const tag of note.parsed.tags) insertTag.run({ noteId: id, tag });
    }

    tx.update(vaultImports).set({ updatedAt: now }).where(eq(vaultImports.id, importId)).run();
    return { removed: gone.length, added: written.length - rewritten.length, updated: rewritten.length };
  };

  return {
    listImports(): VaultImportRow[] {
      return db.select().from(vaultImports).orderBy(asc(vaultImports.createdAt)).all().map((row) => withCount(db, row));
    },

    findImport(id: string): VaultImportRow | undefined {
      const row = db.select().from(vaultImports).where(eq(vaultImports.id, id)).get();
      return row && withCount(db, row);
    },

    /** Each note's hash by path, so an import can skip files that haven't changed. */
    noteHashes(importId: string): Map<string, string> {
      return new Map(db.select({ path: notes.path, hash: notes.hash }).from(notes).where(eq(notes.importId, importId)).all().map((n) => [n.path, n.hash]));
    },

    /** Creates an import with its first snapshot, all or nothing. Throws DuplicateImportName if the name is taken. */
    createImport(name: string, snapshot: VaultSnapshot) {
      const now = clock();
      return db.transaction((tx) => {
        if (tx.select({ id: vaultImports.id }).from(vaultImports).where(eq(vaultImports.name, name)).get()) {
          throw new DuplicateImportName(`An import called "${name}" already exists`);
        }
        const row = { id: randomUUID(), name, source: "obsidian" as const, createdAt: now, updatedAt: now };
        tx.insert(vaultImports).values(row).run();
        const counts = applySnapshot(tx, row.id, snapshot, now);
        return { row: withCount(tx, row), ...counts };
      });
    },

    /** Replaces an import's notes with a new snapshot, all or nothing. Undefined if the import is unknown. */
    replaceSnapshot(importId: string, snapshot: VaultSnapshot) {
      const now = clock();
      return db.transaction((tx) => {
        const row = tx.select().from(vaultImports).where(eq(vaultImports.id, importId)).get();
        if (!row) return undefined;
        const counts = applySnapshot(tx, importId, snapshot, now);
        return { row: withCount(tx, { ...row, updatedAt: now }), ...counts };
      });
    },

    /**
     * Deletes an import; its notes, chunks, links and tags follow by cascade, and triggers drop them from search. So do
     * the memories, concept sources and edges drawn from its notes, and then any concept no other note supports.
     */
    deleteImport(id: string): boolean {
      return db.transaction((tx) => {
        const deleted = tx.delete(vaultImports).where(eq(vaultImports.id, id)).run().changes > 0;
        if (deleted) dropUnsupportedConcepts(tx);
        return deleted;
      });
    },

    findNote(id: string): (NoteRow & { tags: string[] }) | undefined {
      const row = db.select().from(notes).where(eq(notes.id, id)).get();
      if (!row) return undefined;
      const tags = db.select({ tag: noteTags.tag }).from(noteTags).where(eq(noteTags.noteId, id)).orderBy(asc(noteTags.tag)).all().map((t) => t.tag);
      return { ...row, tags };
    },

    /** Every note's title and path, without its text, for linking to notes from an export. */
    noteIndex(): { id: string; title: string; titleKey: string; path: string }[] {
      return db.select({ id: notes.id, title: notes.title, titleKey: notes.titleKey, path: notes.path }).from(notes).orderBy(asc(notes.path)).all();
    },

    /** An import's notes in path order, with their tags, and every link from them. */
    importGraph(importId: string) {
      const rows = db.select({ id: notes.id, path: notes.path, title: notes.title, titleKey: notes.titleKey, aliases: notes.aliases }).from(notes).where(eq(notes.importId, importId)).orderBy(asc(notes.path)).all();
      const tagRows = db.all<{ noteId: string; tag: string }>(sql`
        select t.note_id as noteId, t.tag from note_tags t join notes n on n.id = t.note_id
        where n.import_id = ${importId} order by t.tag`);
      const links = db.all<NoteLinkRow>(sql`
        select l.note_id as noteId, l.target, l.kind from note_links l join notes n on n.id = l.note_id
        where n.import_id = ${importId} order by n.path, l.target`);
      const tags = new Map<string, string[]>();
      for (const { noteId, tag } of tagRows) tags.set(noteId, [...(tags.get(noteId) ?? []), tag]);
      return { notes: rows.map((n) => ({ ...n, tags: tags.get(n.id) ?? [] })), links };
    },

    /**
     * Up to `limit` of an import's notes whose title or path contains `text`, ignoring case: titles that start
     * with it first, then shorter paths. `%`, `_` and `\` in `text` are matched as written.
     */
    findNotes(importId: string, text: string, limit: number): { id: string; title: string; path: string }[] {
      const escaped = text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
      return db.all<{ id: string; title: string; path: string }>(sql`
        select id, title, path from notes
        where import_id = ${importId} and (lower(title) like ${`%${escaped}%`} escape '\\' or lower(path) like ${`%${escaped}%`} escape '\\')
        order by lower(title) like ${`${escaped}%`} escape '\\' desc, length(path), path
        limit ${limit}`);
    },

    /** Chunks of every imported note matching an FTS5 query, best first. The query must already be safe: see ftsQuery. */
    searchNoteChunks(query: string, limit: number): NoteExcerpt[] {
      return db.all<NoteExcerpt>(sql`
        select c.id as chunkId, n.id as noteId, n.import_id as importId, n.path, n.title, c.heading, c.seq, c.text, f.rank
        from note_chunks_fts f
        join note_chunks c on c.id = f.rowid
        join notes n on n.id = c.note_id
        where note_chunks_fts match ${query}
        order by f.rank
        limit ${limit}`);
    },

    /** Which of the chunks `chunkIds` match an FTS5 query. The query must already be safe: see ftsQuery. */
    chunksMatching(query: string, chunkIds: number[]): Set<number> {
      if (chunkIds.length === 0) return new Set();
      const ids = sql.join(chunkIds.map((id) => sql`${id}`), sql`, `);
      return new Set(db.all<{ id: number }>(sql`select rowid as id from note_chunks_fts where note_chunks_fts match ${query} and rowid in (${ids})`).map((r) => r.id));
    },

    /** How many notes every import holds together. */
    countNotes(): number {
      return db.select({ value: count() }).from(notes).get()?.value ?? 0;
    },

    /** Up to `limit` of a note's links and embeds, in the order they're written. */
    noteLinks(noteId: string, limit: number): NoteLinkRow[] {
      return db.all<NoteLinkRow>(sql`select note_id as noteId, target, kind from note_links where note_id = ${noteId} order by rowid limit ${limit}`);
    },

    /**
     * The notes in an import that a link written as one of `nameKeys` could resolve to: those with that title or
     * alias. A note's title is its file name, so a link with a folder needs only its last part here. Passing these
     * to resolveGraph resolves the links exactly as the whole import would, without reading every note.
     */
    linkCandidates(importId: string, nameKeys: string[]) {
      if (nameKeys.length === 0) return [];
      const keys = sql.join(nameKeys.map((key) => sql`${key}`), sql`, `);
      return db.all<{ id: string; path: string; title: string; titleKey: string; aliases: string }>(sql`
        select id, path, title, title_key as titleKey, aliases from notes
        where import_id = ${importId}
          and (title_key in (${keys}) or (aliases != '[]' and exists (select 1 from json_each(aliases) where value in (${keys}))))`)
        .map((n) => ({ ...n, aliases: JSON.parse(n.aliases) as string[], tags: [] as string[] }));
    },
  };
}

export type NoteStore = ReturnType<typeof createNoteStore>;
