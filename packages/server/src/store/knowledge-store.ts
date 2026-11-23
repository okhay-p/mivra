import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { closeSpelling, nameIndex } from "../notes/distil.js";
import { conceptKey } from "../runtime/learner-context.js";
import {
  conceptEdges,
  conceptSessionEdges,
  conceptSessionSources,
  conceptSources,
  concepts,
  memories,
  memorySources,
  notes,
  noteTags,
  type conceptEdgeKinds,
} from "../db/schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EdgeKind = (typeof conceptEdgeKinds)[number];

/** One directed (`prerequisite`) or symmetric (`related`) edge between two distilled concepts. */
export interface ConceptGraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

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
    detachMemories(tx, batch);
    tx.delete(memories).where(and(inArray(memories.noteId, batch), eq(memories.basis, "import"), isNull(memories.editedAt))).run();
  }
  dropUnsupportedConcepts(tx);
}

/**
 * Takes notes out from under the memories they support, before the notes are deleted or rewritten: a memory another
 * note still supports moves to the one that has supported it longest and says what that note said (two notes on one
 * concept may cover different things), unless the learner edited it; the rest keep pointing at theirs for the caller
 * to remove (deleting a note removes them by cascade). Notes not yet detached may be picked; they move on in turn when
 * they're detached.
 */
export function detachMemories(tx: Db | Tx, noteIds: string[]) {
  if (noteIds.length === 0) return;
  tx.delete(memorySources).where(inArray(memorySources.noteId, noteIds)).run();
  const ids = sql.join(noteIds.map((id) => sql`${id}`), sql`, `);
  // The supporter recorded first takes it (rowid order; note ids are random). SET reads the row as it was, so both
  // subqueries pick the same one.
  tx.run(sql`
    update memories set
      note_id = (select s.note_id from memory_sources s where s.memory_id = memories.id order by s.rowid limit 1),
      text = case when edited_at is null
        then (select s.text from memory_sources s where s.memory_id = memories.id order by s.rowid limit 1)
        else text end
    where note_id in (${ids}) and exists (select 1 from memory_sources s where s.memory_id = memories.id)`);
}

/**
 * Deletes concepts no note or session supports any more: none lists it as a source, and no edge touches it. An edge
 * keeps its ends, so rewriting one note doesn't break the edges other notes or sessions drew to its concepts.
 */
export function dropUnsupportedConcepts(tx: Db | Tx) {
  tx.run(sql`
    delete from concepts where not exists (select 1 from concept_sources s where s.concept_id = concepts.id)
      and not exists (select 1 from concept_session_sources s where s.concept_id = concepts.id)
      and not exists (select 1 from concept_edges e where e.from_id = concepts.id or e.to_id = concepts.id)
      and not exists (select 1 from concept_session_edges e where e.from_id = concepts.id or e.to_id = concepts.id)`);
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

    /**
     * Up to `limit` concepts whose normalized `key` (`conceptKey`, Unicode NFKC + lowercase) contains `text`:
     * prefix matches first, then shorter keys, then name order. `%`, `_` and `\` in `text` are matched literally.
     */
    findConcepts(text: string, limit: number): { id: string; name: string }[] {
      const query = conceptKey(text);
      if (!query) return [];
      const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
      return db.all<{ id: string; name: string }>(sql`
        select id, name from concepts
        where key like ${`%${escaped}%`} escape '\\'
        order by key like ${`${escaped}%`} escape '\\' desc, length(key), name
        limit ${limit}`);
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
          // A prerequisite both ways is a contradiction; the first one stated stands (whether from notes or a session).
          if (
            edge.kind === "prerequisite" &&
            (tx.select().from(conceptEdges).where(and(eq(conceptEdges.fromId, to), eq(conceptEdges.toId, from), eq(conceptEdges.kind, "prerequisite"))).get() ||
              tx.select().from(conceptSessionEdges).where(and(eq(conceptSessionEdges.fromId, to), eq(conceptSessionEdges.toId, from), eq(conceptSessionEdges.kind, "prerequisite"))).get())
          ) {
            continue;
          }
          savedEdges += tx.insert(conceptEdges).values({ fromId: from, toId: to, kind: edge.kind, noteId: edge.noteId }).onConflictDoNothing().run().changes;
        }
        // Repeats are skipped: of what the learner said, or of what this import's notes already gave. A repeat of this
        // import's own memory adds its note, with its own text, as one more support, so the memory outlives the note it
        // was first drawn from and then says what the note it moves to said. Another import may say the same and keeps its own copy, so deleting one import doesn't take the
        // other's. The memories to compare with are read once per kind and import, not once per memory: an import of a
        // thousand notes has about as many memories, and every group would otherwise re-read and re-key them all.
        // Each set maps a text or concept key to the memory of this import saying it, or null for the learner's own.
        const alikeSets = new Map<string, { texts: Map<string, string | null>; conceptKeys: Map<string, string | null> }>();
        const alikeFor = (kind: string, importId: string) => {
          const cacheKey = `${kind}\u0000${importId}`;
          let found = alikeSets.get(cacheKey);
          if (!found) {
            const rows = tx.all<{ id: string; text: string; concept: string | null; ours: number }>(sql`
              select m.id, m.text, m.concept, m.basis = 'import' as ours from memories m left join notes n on n.id = m.note_id
              where m.kind = ${kind} and m.status = 'active' and (m.basis != 'import' or n.import_id = ${importId})`);
            found = { texts: new Map(), conceptKeys: new Map() };
            for (const m of rows) {
              const id = m.ours ? m.id : null;
              const text = normalText(m.text);
              if (!found.texts.get(text)) found.texts.set(text, id);
              if (m.concept && !found.conceptKeys.get(conceptKey(m.concept))) found.conceptKeys.set(conceptKey(m.concept), id);
            }
            alikeSets.set(cacheKey, found);
          }
          return found;
        };
        const memoryRows: (typeof memories.$inferInsert)[] = [];
        const supportRows: (typeof memorySources.$inferInsert)[] = [];
        for (const memory of distilled.memories) {
          if (!current.has(memory.noteId)) continue;
          const alike = alikeFor(memory.kind, importOf.get(memory.noteId)!);
          const text = normalText(memory.text);
          // One `known` memory per concept per import: many notes covering it don't need saying many times.
          const repeat = alike.texts.has(text) ? alike.texts.get(text) : memory.kind === "known" && memory.conceptKey && alike.conceptKeys.has(memory.conceptKey) ? alike.conceptKeys.get(memory.conceptKey) : undefined;
          if (repeat !== undefined) {
            if (repeat) supportRows.push({ memoryId: repeat, noteId: memory.noteId, text: memory.text });
            continue;
          }
          const id = randomUUID();
          memoryRows.push({ id, kind: memory.kind, text: memory.text, concept: memory.concept, basis: "import", noteId: memory.noteId, status: "active", createdAt: now });
          supportRows.push({ memoryId: id, noteId: memory.noteId, text: memory.text });
          alike.texts.set(text, id);
          if (memory.concept && !alike.conceptKeys.get(conceptKey(memory.concept))) alike.conceptKeys.set(conceptKey(memory.concept), id);
        }
        for (const batch of batches(memoryRows)) tx.insert(memories).values(batch).run();
        for (const batch of batches(supportRows)) tx.insert(memorySources).values(batch).onConflictDoNothing().run();
        return { concepts: savedConcepts, edges: savedEdges, memories: memoryRows.length };
      });
    },

    /** Marks notes distilled at the text they were read with; one that has changed since stays waiting. */
    markDistilled(read: Map<string, string>) {
      db.transaction(() => {
        for (const [id, hash] of read) markOne.run({ id, hash });
      });
    },

    /**
     * Records a concept link proposed during a live tutoring session (ADR-014, issue #140).
     * Reuses `conceptKey` + `closeSpelling` normalization against existing graph nodes (and then recent
     * attempt/memory concept names), rejects self-loops and contradictory prerequisites, and enforces
     * `MAX_CONCEPT_NODES` atomically so partial nodes are never written.
     */
    saveSessionEdge(input: { sessionId: string; from: string; to: string; kind: EdgeKind }):
      | { ok: true; from: string; to: string; kind: EdgeKind; created: boolean }
      | { ok: false; reason: string } {
      const now = clock();
      return db.transaction((tx) => {
        const rawFrom = input.from.trim();
        const rawTo = input.to.trim();
        const rawFromKey = conceptKey(rawFrom);
        const rawToKey = conceptKey(rawTo);
        if (!rawFromKey || !rawToKey) {
          return { ok: false as const, reason: "Both concept names must be non-empty." };
        }

        const existingNodes = tx.select({ id: concepts.id, key: concepts.key, name: concepts.name }).from(concepts).orderBy(asc(concepts.name)).all();
        const nodeByKey = new Map(existingNodes.map((n) => [n.key, n]));
        const nodeIndex = nameIndex(existingNodes);
        const otherNames = tx
          .all<{ concept: string }>(sql`select concept from attempts where concept is not null group by concept order by max(created_at) desc limit 300`)
          .concat(
            tx.all<{ concept: string }>(
              sql`select concept from memories where concept is not null and status = 'active' and basis != 'import' group by concept order by max(created_at) desc limit 300`,
            ),
          )
          .map((r) => ({ key: conceptKey(r.concept), name: r.concept }))
          .filter((r) => r.key.length > 0);
        const otherIndex = nameIndex(otherNames);

        const resolve = (raw: string, key: string) => {
          const matchedNode = nodeIndex.find(raw, key);
          if (matchedNode) return { node: nodeByKey.get(matchedNode.key)!, key: matchedNode.key, name: matchedNode.name };
          const matchedOther = otherIndex.find(raw, key);
          if (matchedOther) return { node: undefined, key: matchedOther.key, name: matchedOther.name };
          return { node: undefined, key, name: raw };
        };

        const from = resolve(rawFrom, rawFromKey);
        const to = resolve(rawTo, rawToKey);

        if (from.key === to.key || closeSpelling(from.name, to.name)) {
          return { ok: false as const, reason: "An edge needs two different concepts." };
        }

        if (input.kind === "prerequisite" && from.node && to.node) {
          const reverseNote = tx
            .select()
            .from(conceptEdges)
            .where(and(eq(conceptEdges.fromId, to.node.id), eq(conceptEdges.toId, from.node.id), eq(conceptEdges.kind, "prerequisite")))
            .get();
          const reverseSession = tx
            .select()
            .from(conceptSessionEdges)
            .where(and(eq(conceptSessionEdges.fromId, to.node.id), eq(conceptSessionEdges.toId, from.node.id), eq(conceptSessionEdges.kind, "prerequisite")))
            .get();
          if (reverseNote || reverseSession) {
            return {
              ok: false as const,
              reason: `Contradicts an existing prerequisite: "${to.name}" is already a prerequisite of "${from.name}".`,
            };
          }
        }

        const neededNodes = (from.node ? 0 : 1) + (to.node ? 0 : 1);
        if (existingNodes.length + neededNodes > MAX_CONCEPT_NODES) {
          return { ok: false as const, reason: `The concept graph has reached its ${MAX_CONCEPT_NODES.toLocaleString("en")}-concept limit.` };
        }

        let fromId = from.node?.id;
        if (!fromId) {
          fromId = randomUUID();
          tx.insert(concepts).values({ id: fromId, key: from.key, name: from.name, createdAt: now }).run();
        }
        let toId = to.node?.id;
        if (!toId) {
          toId = randomUUID();
          tx.insert(concepts).values({ id: toId, key: to.key, name: to.name, createdAt: now }).run();
        }

        tx.insert(conceptSessionSources)
          .values([
            { id: randomUUID(), conceptId: fromId, sessionId: input.sessionId, createdAt: now },
            { id: randomUUID(), conceptId: toId, sessionId: input.sessionId, createdAt: now },
          ])
          .onConflictDoNothing()
          .run();

        let edgeFrom = fromId;
        let edgeTo = toId;
        if (input.kind === "related" && edgeFrom > edgeTo) [edgeFrom, edgeTo] = [edgeTo, edgeFrom];

        const inserted = tx
          .insert(conceptSessionEdges)
          .values({ id: randomUUID(), fromId: edgeFrom, toId: edgeTo, kind: input.kind, sessionId: input.sessionId, createdAt: now })
          .onConflictDoNothing()
          .run().changes;

        return { ok: true as const, from: from.name, to: to.name, kind: input.kind, created: inserted > 0 };
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
      for (const e of db.select({ fromId: conceptSessionEdges.fromId, toId: conceptSessionEdges.toId, kind: conceptSessionEdges.kind }).from(conceptSessionEdges).orderBy(asc(conceptSessionEdges.fromId), asc(conceptSessionEdges.toId)).all()) {
        const key = `${e.fromId}|${e.toId}|${e.kind}`;
        if (!edges.has(key)) edges.set(key, { from: e.fromId, to: e.toId, kind: e.kind, notes: [] });
      }
      return { concepts: nodes.map((n) => ({ ...n, notes: sources.get(n.id) ?? [] })), edges: [...edges.values()] };
    },

    /** Concepts supported by the given notes, in key order. */
    conceptsForNotes(noteIds: string[], limit = MAX_CONCEPT_NODES): { key: string; name: string }[] {
      const unique = [...new Set(noteIds)];
      const max = Math.floor(limit);
      if (unique.length === 0 || !Number.isFinite(max) || max <= 0) return [];
      const found = new Map<string, string>();
      for (const batch of batches(unique)) {
        const rows = db
          .selectDistinct({ key: concepts.key, name: concepts.name })
          .from(conceptSources)
          .innerJoin(concepts, eq(concepts.id, conceptSources.conceptId))
          .where(inArray(conceptSources.noteId, batch))
          .orderBy(asc(concepts.key))
          .limit(max)
          .all();
        for (const row of rows) {
          if (!found.has(row.key)) found.set(row.key, row.name);
        }
      }
      return [...found.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, max)
        .map(([key, name]) => ({ key, name }));
    },

    /** Source notes supporting any of the given concept keys, ranked by how many matched concepts they support, then path. */
    notesForConcepts(conceptKeys: string[], limit = MAX_CONCEPT_NODES): { id: string; importId: string; path: string; title: string }[] {
      const keys = [...new Set(conceptKeys.map(conceptKey).filter(Boolean))];
      const max = Math.floor(limit);
      if (keys.length === 0 || !Number.isFinite(max) || max <= 0) return [];
      const keyBatches = batches(keys);
      const found = new Map<string, { id: string; importId: string; path: string; title: string; matched: number }>();
      for (const batch of keyBatches) {
        const keyList = sql.join(batch.map((key) => sql`${key}`), sql`, `);
        const rows = db.all<{ id: string; importId: string; path: string; title: string; matched: number }>(
          keyBatches.length === 1
            ? sql`
                select n.id, n.import_id as importId, n.path, n.title, count(distinct s.concept_id) as matched
                from concepts c
                join concept_sources s on s.concept_id = c.id
                join notes n on n.id = s.note_id
                where c.key in (${keyList})
                group by n.id
                order by matched desc, n.path asc
                limit ${max}`
            : sql`
                select n.id, n.import_id as importId, n.path, n.title, count(distinct s.concept_id) as matched
                from concepts c
                join concept_sources s on s.concept_id = c.id
                join notes n on n.id = s.note_id
                where c.key in (${keyList})
                group by n.id`,
        );
        for (const row of rows) {
          const existing = found.get(row.id);
          if (existing) existing.matched += row.matched;
          else found.set(row.id, { ...row });
        }
      }
      return [...found.values()]
        .sort((a, b) => b.matched - a.matched || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, max)
        .map(({ id, importId, path, title }) => ({ id, importId, path, title }));
    },

    /**
     * Bounded 1-hop edges (`prerequisite` and `related`) touching any of the seed concept keys.
     * Prioritises edges between two seed concepts, then `prerequisite` over `related`, then edges
     * supported by more notes, and finally key order (with `related` endpoints ordered by key) so
     * results are deterministic regardless of random concept ids or input order.
     */
    conceptNeighborhood(conceptKeys: string[], limit: number): ConceptGraphEdge[] {
      const keys = [...new Set(conceptKeys.map(conceptKey).filter(Boolean))];
      const max = Math.floor(limit);
      if (keys.length === 0 || !Number.isFinite(max) || max <= 0) return [];
      const seedIds: string[] = [];
      const seedKeySet = new Set<string>();
      for (const batch of batches(keys)) {
        for (const row of db.select({ id: concepts.id, key: concepts.key }).from(concepts).where(inArray(concepts.key, batch)).all()) {
          seedIds.push(row.id);
          seedKeySet.add(row.key);
        }
      }
      if (seedIds.length === 0) return [];
      type Candidate = { fromKey: string; from: string; toKey: string; to: string; kind: EdgeKind; support: number; bothSeeds: number };
      const byEdge = new Map<string, Candidate>();
      // Two IN clauses per query, so halve the batch size to stay well below SQLite's bind limit.
      const edgeBatch = Math.floor(BATCH / 2);
      for (let i = 0; i < seedIds.length; i += edgeBatch) {
        const batch = seedIds.slice(i, i + edgeBatch);
        const ids = sql.join(batch.map((id) => sql`${id}`), sql`, `);
        const rows = db.all<Candidate>(sql`
          select
            case when e.kind = 'related' and f.key > t.key then t.key else f.key end as fromKey,
            case when e.kind = 'related' and f.key > t.key then t.name else f.name end as "from",
            case when e.kind = 'related' and f.key > t.key then f.key else t.key end as toKey,
            case when e.kind = 'related' and f.key > t.key then f.name else t.name end as "to",
            e.kind as kind,
            count(*) as support,
            case when e.from_id in (${ids}) and e.to_id in (${ids}) then 0 else 1 end as bothSeeds
          from (
            select from_id, to_id, kind from concept_edges
            union all
            select from_id, to_id, kind from concept_session_edges
          ) e
          join concepts f on f.id = e.from_id
          join concepts t on t.id = e.to_id
          where e.from_id in (${ids}) or e.to_id in (${ids})
          group by e.from_id, e.to_id, e.kind
          order by
            bothSeeds asc,
            case e.kind when 'prerequisite' then 0 else 1 end asc,
            support desc,
            fromKey asc,
            toKey asc
          limit ${max}
        `);
        for (const row of rows) {
          const edgeKey = `${row.kind}\u0000${row.fromKey}\u0000${row.toKey}`;
          if (!byEdge.has(edgeKey)) {
            byEdge.set(edgeKey, {
              ...row,
              bothSeeds: seedKeySet.has(row.fromKey) && seedKeySet.has(row.toKey) ? 0 : 1,
            });
          }
        }
      }
      const kindRank = (k: EdgeKind) => (k === "prerequisite" ? 0 : 1);
      return [...byEdge.values()]
        .sort(
          (a, b) =>
            a.bothSeeds - b.bothSeeds ||
            kindRank(a.kind) - kindRank(b.kind) ||
            b.support - a.support ||
            (a.fromKey < b.fromKey ? -1 : a.fromKey > b.fromKey ? 1 : 0) ||
            (a.toKey < b.toKey ? -1 : a.toKey > b.toKey ? 1 : 0),
        )
        .slice(0, max)
        .map(({ from, to, kind }) => ({ from, to, kind }));
    },
  };
}

export type KnowledgeStore = ReturnType<typeof createKnowledgeStore>;
