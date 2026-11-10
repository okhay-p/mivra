import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { conceptKey } from "../runtime/learner-context.js";
import { conceptEdges, conceptSources, concepts, memories, notes, noteTags, type conceptEdgeKinds } from "../db/schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EdgeKind = (typeof conceptEdgeKinds)[number];

/** A note waiting to be distilled: its text as it is now, and the hash that text has. */
export type PendingNote = { id: string; path: string; title: string; body: string; hash: string; tags: string[] };

/** What one group of notes yielded, already validated (see notes/distil.ts). Concepts are named by `conceptKey`. */
export interface Distilled {
  concepts: { key: string; name: string; noteIds: string[] }[];
  edges: { fromKey: string; toKey: string; kind: EdgeKind; noteId: string }[];
  memories: { kind: "known" | "goal" | "misconception"; text: string; concept: string | null; conceptKey: string | null; noteId: string }[];
}

/** Most concept nodes kept, so a hostile vault can't grow the graph without end. */
export const MAX_CONCEPT_NODES = 5_000;

const BATCH = 500;
const batches = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH) }, (_, i) => items.slice(i * BATCH, (i + 1) * BATCH));
/** A memory's text as repeats are compared: ignoring case and surrounding space. */
const normalText = (text: string) => text.trim().toLowerCase();

/**
 * Forgets what notes yielded, before they're rewritten (ADR-014: re-import is a snapshot). Memories the learner
 * edited are theirs now, so they stay until the note itself is deleted. Runs inside the caller's transaction.
 */
export function clearDistilled(tx: Db | Tx, noteIds: string[]) {
  for (const batch of batches(noteIds)) {
    tx.delete(conceptSources).where(inArray(conceptSources.noteId, batch)).run();
    tx.delete(conceptEdges).where(inArray(conceptEdges.noteId, batch)).run();
    tx.delete(memories).where(and(inArray(memories.noteId, batch), eq(memories.basis, "import"), isNull(memories.editedAt))).run();
  }
  dropUnsupportedConcepts(tx);
}

/**
 * Deletes concepts no note supports any more: none lists it as a source, and no edge a note drew touches it. An edge
 * keeps its ends, so rewriting one note doesn't break the edges other notes drew to its concepts.
 */
export function dropUnsupportedConcepts(tx: Db | Tx) {
  tx.run(sql`
    delete from concepts where not exists (select 1 from concept_sources s where s.concept_id = concepts.id)
      and not exists (select 1 from concept_edges e where e.from_id = concepts.id or e.to_id = concepts.id)`);
}

/**
 * The knowledge graph drawn from imported notes (ADR-014): concepts, edges between them, and the memories with
 * basis `import`. Like the other stores, the only code that talks to Drizzle about these tables (ADR-007).
 */
export function createKnowledgeStore(db: Db, clock: () => Date = () => new Date()) {
  // Prepared once: it runs for every note distilled.
  const markOne = db
    .update(notes)
    .set({ distilledHash: sql`${sql.placeholder("hash")}` })
    .where(and(eq(notes.id, sql.placeholder("id")), eq(notes.hash, sql.placeholder("hash"))))
    .prepare();
  return {
    /** An import's notes not yet distilled at their current text, in path order, with their tags. */
    pendingNotes(importId: string): PendingNote[] {
      const rows = db
        .select({ id: notes.id, path: notes.path, title: notes.title, body: notes.body, hash: notes.hash })
        .from(notes)
        .where(and(eq(notes.importId, importId), sql`(${notes.distilledHash} is null or ${notes.distilledHash} != ${notes.hash})`))
        .orderBy(asc(notes.path))
        .all();
      const tags = new Map<string, string[]>();
      for (const batch of batches(rows.map((r) => r.id))) {
        for (const { noteId, tag } of db.select().from(noteTags).where(inArray(noteTags.noteId, batch)).orderBy(asc(noteTags.tag)).all()) {
          tags.set(noteId, [...(tags.get(noteId) ?? []), tag]);
        }
      }
      return rows.map((r) => ({ ...r, tags: tags.get(r.id) ?? [] }));
    },

    countPending(importId: string): number {
      return (
        db.get<{ n: number }>(sql`select count(*) as n from notes where import_id = ${importId} and (distilled_hash is null or distilled_hash != hash)`)?.n ?? 0
      );
    },

    /** Concepts and active memories drawn from an import's notes. */
    counts(importId: string): { concepts: number; memories: number } {
      const conceptCount = db.get<{ n: number }>(sql`
        select count(distinct s.concept_id) as n from concept_sources s join notes n on n.id = s.note_id where n.import_id = ${importId}`)?.n ?? 0;
      const memoryCount = db.get<{ n: number }>(sql`
        select count(*) as n from memories m join notes n on n.id = m.note_id where n.import_id = ${importId} and m.status = 'active'`)?.n ?? 0;
      return { concepts: conceptCount, memories: memoryCount };
    },

    /** An import's tags, most used first. */
    importTags(importId: string, limit: number): { tag: string; notes: number }[] {
      return db.all<{ tag: string; notes: number }>(sql`
        select t.tag, count(*) as notes from note_tags t join notes n on n.id = t.note_id
        where n.import_id = ${importId} group by t.tag order by notes desc, t.tag limit ${limit}`);
    },

    /** Every concept node's name, for matching proposals against. */
    conceptNodes(): { key: string; name: string }[] {
      return db.select({ key: concepts.key, name: concepts.name }).from(concepts).orderBy(asc(concepts.name)).all();
    },

    /** Concept names the learner already has elsewhere: graded checks first, then memories. Not graph nodes yet. */
    otherConceptNames(limit: number): string[] {
      const fromAttempts = db.all<{ concept: string }>(sql`select concept from attempts where concept is not null group by concept order by max(created_at) desc limit ${limit}`);
      const fromMemories = db.all<{ concept: string }>(sql`
        select concept from memories where concept is not null and status = 'active' and basis != 'import' group by concept order by max(created_at) desc limit ${limit}`);
      return [...fromAttempts, ...fromMemories].map((r) => r.concept).slice(0, limit);
    },

    /**
     * Saves what one group of notes yielded, all or nothing. A note whose text changed (or that was deleted) since it
     * was read gets nothing: its new text waits for its own turn. `read` maps each note read to the hash it had then.
     */
    saveDistilled(read: Map<string, string>, distilled: Distilled): { concepts: number; edges: number; memories: number } {
      const now = clock();
      return db.transaction((tx) => {
        // Statements are batched: a group of notes yields dozens of rows, and each statement built and prepared on its
        // own costs about a millisecond of the server's time, which a streaming reply would wait on.
        const current = new Set<string>();
        const importOf = new Map<string, string>();
        for (const batch of batches([...read.keys()])) {
          for (const row of tx.select({ id: notes.id, hash: notes.hash, importId: notes.importId }).from(notes).where(inArray(notes.id, batch)).all()) {
            if (read.get(row.id) === row.hash) {
              current.add(row.id);
              importOf.set(row.id, row.importId);
            }
          }
        }
        const ids = new Map<string, string>();
        const wanted = [...new Set([...distilled.concepts.map((c) => c.key), ...distilled.edges.flatMap((e) => [e.fromKey, e.toKey])])];
        for (const batch of batches(wanted)) {
          for (const row of tx.select({ id: concepts.id, key: concepts.key }).from(concepts).where(inArray(concepts.key, batch)).all()) ids.set(row.key, row.id);
        }
        let nodes = tx.get<{ n: number }>(sql`select count(*) as n from concepts`)?.n ?? 0;
        let savedConcepts = 0;
        const newConcepts: (typeof concepts.$inferInsert)[] = [];
        const sourceRows: (typeof conceptSources.$inferInsert)[] = [];
        for (const concept of distilled.concepts) {
          const sources = concept.noteIds.filter((id) => current.has(id));
          if (sources.length === 0) continue;
          let id = ids.get(concept.key);
          if (!id) {
            if (nodes >= MAX_CONCEPT_NODES) continue;
            id = randomUUID();
            newConcepts.push({ id, key: concept.key, name: concept.name, createdAt: now });
            ids.set(concept.key, id);
            nodes++;
          }
          for (const noteId of sources) sourceRows.push({ conceptId: id, noteId });
          savedConcepts++;
        }
        for (const batch of batches(newConcepts)) tx.insert(concepts).values(batch).run();
        for (const batch of batches(sourceRows)) tx.insert(conceptSources).values(batch).onConflictDoNothing().run();
        let savedEdges = 0;
        for (const edge of distilled.edges) {
          if (!current.has(edge.noteId)) continue;
          let from = ids.get(edge.fromKey);
          let to = ids.get(edge.toKey);
          if (!from || !to || from === to) continue;
          if (edge.kind === "related" && from > to) [from, to] = [to, from];
          // A prerequisite both ways is a contradiction; the first one stated stands.
          if (edge.kind === "prerequisite" && tx.select().from(conceptEdges).where(and(eq(conceptEdges.fromId, to), eq(conceptEdges.toId, from), eq(conceptEdges.kind, "prerequisite"))).get()) continue;
          savedEdges += tx.insert(conceptEdges).values({ fromId: from, toId: to, kind: edge.kind, noteId: edge.noteId }).onConflictDoNothing().run().changes;
        }
        // Repeats are skipped: of what the learner said, or of what this import's notes already gave. Another import
        // may say the same and keeps its own copy, so deleting one import doesn't take the other's. The memories to
        // compare with are read once per kind and import, not once per memory: an import of a thousand notes has
        // about as many memories, and every group would otherwise re-read and re-key them all.
        const alikeSets = new Map<string, { texts: Set<string>; conceptKeys: Set<string> }>();
        const alikeFor = (kind: string, importId: string) => {
          const cacheKey = `${kind}\u0000${importId}`;
          let found = alikeSets.get(cacheKey);
          if (!found) {
            const rows = tx.all<{ text: string; concept: string | null }>(sql`
              select m.text, m.concept from memories m left join notes n on n.id = m.note_id
              where m.kind = ${kind} and m.status = 'active' and (m.basis != 'import' or n.import_id = ${importId})`);
            found = { texts: new Set(rows.map((m) => normalText(m.text))), conceptKeys: new Set(rows.flatMap((m) => (m.concept ? [conceptKey(m.concept)] : []))) };
            alikeSets.set(cacheKey, found);
          }
          return found;
        };
        const memoryRows: (typeof memories.$inferInsert)[] = [];
        for (const memory of distilled.memories) {
          if (!current.has(memory.noteId)) continue;
          const alike = alikeFor(memory.kind, importOf.get(memory.noteId)!);
          if (alike.texts.has(normalText(memory.text))) continue;
          // One `known` memory per concept per import: many notes covering it don't need saying many times.
          if (memory.kind === "known" && memory.conceptKey && alike.conceptKeys.has(memory.conceptKey)) continue;
          memoryRows.push({ id: randomUUID(), kind: memory.kind, text: memory.text, concept: memory.concept, basis: "import", noteId: memory.noteId, status: "active", createdAt: now });
          alike.texts.add(normalText(memory.text));
          if (memory.concept) alike.conceptKeys.add(conceptKey(memory.concept));
        }
        for (const batch of batches(memoryRows)) tx.insert(memories).values(batch).run();
        return { concepts: savedConcepts, edges: savedEdges, memories: memoryRows.length };
      });
    },

    /** Marks notes distilled at the text they were read with; one that has changed since stays waiting. */
    markDistilled(read: Map<string, string>) {
      db.transaction(() => {
        for (const [id, hash] of read) markOne.run({ id, hash });
      });
    },

    /** Every concept node and edge, each with the notes behind it, for the graph view and export. */
    conceptGraph() {
      const nodes = db.select({ id: concepts.id, name: concepts.name }).from(concepts).orderBy(asc(concepts.name)).all();
      const sources = new Map<string, string[]>();
      for (const s of db.select().from(conceptSources).orderBy(asc(conceptSources.noteId)).all()) sources.set(s.conceptId, [...(sources.get(s.conceptId) ?? []), s.noteId]);
      const edges = new Map<string, { from: string; to: string; kind: EdgeKind; notes: string[] }>();
      for (const e of db.select().from(conceptEdges).orderBy(asc(conceptEdges.fromId), asc(conceptEdges.toId), asc(conceptEdges.noteId)).all()) {
        const key = `${e.fromId}|${e.toId}|${e.kind}`;
        const edge = edges.get(key) ?? { from: e.fromId, to: e.toId, kind: e.kind, notes: [] };
        edge.notes.push(e.noteId);
        edges.set(key, edge);
      }
      return { concepts: nodes.map((n) => ({ ...n, notes: sources.get(n.id) ?? [] })), edges: [...edges.values()] };
    },
  };
}

export type KnowledgeStore = ReturnType<typeof createKnowledgeStore>;
