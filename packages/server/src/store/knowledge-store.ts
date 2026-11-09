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
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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

/** Deletes concepts no note supports any more; their edges follow by cascade. */
export function dropUnsupportedConcepts(tx: Db | Tx) {
  tx.run(sql`delete from concepts where not exists (select 1 from concept_sources s where s.concept_id = concepts.id)`);
}

/**
 * The knowledge graph drawn from imported notes (ADR-014): concepts, edges between them, and the memories with
 * basis `import`. Like the other stores, the only code that talks to Drizzle about these tables (ADR-007).
 */
export function createKnowledgeStore(db: Db, clock: () => Date = () => new Date()) {
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
        const current = new Set<string>();
        for (const batch of batches([...read.keys()])) {
          for (const row of tx.select({ id: notes.id, hash: notes.hash }).from(notes).where(inArray(notes.id, batch)).all()) {
            if (read.get(row.id) === row.hash) current.add(row.id);
          }
        }
        const ids = new Map<string, string>();
        const conceptId = (key: string) => {
          if (ids.has(key)) return ids.get(key);
          const id = tx.select({ id: concepts.id }).from(concepts).where(eq(concepts.key, key)).get()?.id;
          if (id) ids.set(key, id);
          return id;
        };
        let nodes = tx.get<{ n: number }>(sql`select count(*) as n from concepts`)?.n ?? 0;
        let savedConcepts = 0;
        for (const concept of distilled.concepts) {
          const sources = concept.noteIds.filter((id) => current.has(id));
          if (sources.length === 0) continue;
          let id = conceptId(concept.key);
          if (!id) {
            if (nodes >= MAX_CONCEPT_NODES) continue;
            id = randomUUID();
            tx.insert(concepts).values({ id, key: concept.key, name: concept.name, createdAt: now }).run();
            ids.set(concept.key, id);
            nodes++;
          }
          for (const noteId of sources) tx.insert(conceptSources).values({ conceptId: id, noteId }).onConflictDoNothing().run();
          savedConcepts++;
        }
        let savedEdges = 0;
        for (const edge of distilled.edges) {
          if (!current.has(edge.noteId)) continue;
          let from = conceptId(edge.fromKey);
          let to = conceptId(edge.toKey);
          if (!from || !to || from === to) continue;
          if (edge.kind === "related" && from > to) [from, to] = [to, from];
          // A prerequisite both ways is a contradiction; the first one stated stands.
          if (edge.kind === "prerequisite" && tx.select().from(conceptEdges).where(and(eq(conceptEdges.fromId, to), eq(conceptEdges.toId, from), eq(conceptEdges.kind, "prerequisite"))).get()) continue;
          savedEdges += tx.insert(conceptEdges).values({ fromId: from, toId: to, kind: edge.kind, noteId: edge.noteId }).onConflictDoNothing().run().changes;
        }
        let savedMemories = 0;
        for (const memory of distilled.memories) {
          if (!current.has(memory.noteId)) continue;
          const active = tx.select({ text: memories.text, concept: memories.concept, noteId: memories.noteId }).from(memories).where(and(eq(memories.kind, memory.kind), eq(memories.status, "active"))).all();
          if (active.some((m) => sameText(m.text, memory.text))) continue;
          // One `known` memory per concept per import: many notes covering it don't need saying many times.
          if (memory.kind === "known" && memory.conceptKey) {
            const importId = tx.select({ importId: notes.importId }).from(notes).where(eq(notes.id, memory.noteId)).get()?.importId;
            const known = tx.all<{ concept: string }>(sql`
              select m.concept from memories m join notes n on n.id = m.note_id
              where m.kind = 'known' and m.status = 'active' and n.import_id = ${importId} and m.concept is not null`);
            if (known.some((m) => conceptKey(m.concept) === memory.conceptKey)) continue;
          }
          tx.insert(memories)
            .values({ id: randomUUID(), kind: memory.kind, text: memory.text, concept: memory.concept, basis: "import", noteId: memory.noteId, status: "active", createdAt: now })
            .run();
          savedMemories++;
        }
        return { concepts: savedConcepts, edges: savedEdges, memories: savedMemories };
      });
    },

    /** Marks notes distilled at the text they were read with; one that has changed since stays waiting. */
    markDistilled(read: Map<string, string>) {
      db.transaction((tx) => {
        for (const [noteId, hash] of read) tx.update(notes).set({ distilledHash: hash }).where(and(eq(notes.id, noteId), eq(notes.hash, hash))).run();
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
