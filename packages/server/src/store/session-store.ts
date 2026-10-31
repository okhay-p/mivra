import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { and, asc, desc, eq, isNotNull, max, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { artifacts, attempts, memories, messages, runs, sessions, type RunStatus } from "../db/schema.js";

export type { RunStatus };

export type SessionRow = typeof sessions.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;
export type EvidenceRow = Pick<AttemptRow, "id" | "concept" | "correct" | "createdAt">;
export type MemoryRow = typeof memories.$inferSelect;

/** A write was refused because it would break an invariant (reused message id, overlapping run). */
export class Conflict extends Error {}

const DEFAULT_TITLE = "New session";
/** Most memories one reply can write. */
const MAX_MEMORIES_PER_RUN = 5;

const sameMemoryText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether a memory could give away an unanswered check: its session has a check from the same reply or
 * an earlier one, in a reply that completed, with no attempt yet. The model could see that check's answer.
 */
function heldBy(checkKinds: string[]) {
  if (checkKinds.length === 0) return sql<number>`0`;
  // Spelled out: Drizzle drops table names from columns in single-table selects, which would be ambiguous here.
  const kinds = sql.join(checkKinds.map((kind) => sql`${kind}`), sql`, `);
  return sql<number>`exists (
    select 1 from artifacts a join runs r on r.id = a.run_id
    where a.session_id = "memories"."session_id"
      and a.kind in (${kinds})
      and r.status = 'completed'
      and (a.run_id = "memories"."run_id" or a.created_at <= "memories"."created_at")
      and not exists (select 1 from attempts t where t.artifact_id = a.id)
  )`;
}

function firstText(message: UIMessage): string | undefined {
  const part = message.parts.find((p) => p.type === "text");
  return part && "text" in part ? part.text : undefined;
}

/**
 * All persistence for sessions, messages and runs. This is the only module that talks to Drizzle
 * (ADR-007), so the storage engine and schema can change without touching the runtime or routes.
 */
export function createSessionStore(db: Db) {
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
  const nextSeq = (tx: Tx, sessionId: string) =>
    (tx.select({ value: max(messages.seq) }).from(messages).where(eq(messages.sessionId, sessionId)).get()?.value ?? 0) + 1;

  return {
    /** Marks runs left running by a previous server process as failed. */
    recoverInterruptedRuns() {
      db.update(runs)
        .set({ status: "failed", error: "The server stopped before the reply finished", endedAt: new Date() })
        .where(eq(runs.status, "running"))
        .run();
      // Their replies never completed, so neither did anything they tried to remember.
      db.delete(memories).where(eq(memories.status, "pending")).run();
    },

    listSessions(): SessionRow[] {
      return db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
    },

    createSession(title?: string): SessionRow {
      const now = new Date();
      const row = { id: randomUUID(), title: title ?? DEFAULT_TITLE, createdAt: now, updatedAt: now };
      db.insert(sessions).values(row).run();
      return row;
    },

    findSession(id: string): SessionRow | undefined {
      return db.select().from(sessions).where(eq(sessions.id, id)).get();
    },

    /** Messages in conversation order. */
    loadMessages(sessionId: string): UIMessage[] {
      return db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.seq))
        .all()
        .map((row) => ({ id: row.id, role: row.role, parts: row.parts as UIMessage["parts"] }));
    },

    /**
     * Saves the user message and claims the session's single running slot, atomically.
     * Throws Conflict if the message id was used before or a run is already in progress.
     */
    startRun(session: SessionRow, message: UIMessage): string {
      return db.transaction((tx) => {
        if (tx.select({ id: messages.id }).from(messages).where(eq(messages.id, message.id)).get()) {
          throw new Conflict("This message id has already been used");
        }
        const running = tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.sessionId, session.id), eq(runs.status, "running")))
          .get();
        if (running) throw new Conflict("A reply is already in progress for this session");

        const now = new Date();
        const seq = nextSeq(tx, session.id);
        tx.insert(messages)
          .values({ id: message.id, sessionId: session.id, seq, role: "user", parts: message.parts, createdAt: now })
          .run();
        const runId = randomUUID();
        tx.insert(runs)
          .values({ id: runId, sessionId: session.id, userMessageId: message.id, status: "running", startedAt: now })
          .run();

        const title = seq === 1 && session.title === DEFAULT_TITLE ? firstText(message)?.trim().slice(0, 60) : undefined;
        tx.update(sessions)
          .set({ updatedAt: now, ...(title ? { title } : {}) })
          .where(eq(sessions.id, session.id))
          .run();
        return runId;
      });
    },

    /**
     * Records how a run ended. Only a completed reply is saved: a cancelled or failed reply is partial,
     * and storing it would feed truncated text back to the model as if it were a full answer.
     */
    finishRun(runId: string, sessionId: string, status: RunStatus, reply?: UIMessage, error?: string) {
      db.transaction((tx) => {
        const now = new Date();
        let assistantMessageId: string | undefined;
        if (status === "completed" && reply) {
          assistantMessageId = reply.id;
          tx.insert(messages)
            .values({ id: reply.id, sessionId, seq: nextSeq(tx, sessionId), role: "assistant", parts: reply.parts, createdAt: now })
            .run();
          tx.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run();
        }
        tx.update(runs)
          .set({ status, assistantMessageId, error, endedAt: now })
          .where(and(eq(runs.id, runId), eq(runs.status, "running")))
          .run();

        const pending = and(eq(memories.runId, runId), eq(memories.status, "pending"));
        if (status !== "completed") {
          tx.delete(memories).where(pending).run();
          return;
        }
        // Other runs and the learner may have changed things since these were written, so check again now.
        for (const memory of tx.select().from(memories).where(pending).orderBy(sql`rowid`).all()) {
          const target = memory.replacesId ? tx.select().from(memories).where(eq(memories.id, memory.replacesId)).get() : undefined;
          const staleTarget = memory.replacesId && (target?.status !== "active" || (target.editedAt && target.editedAt >= memory.createdAt));
          const duplicate = tx
            .select()
            .from(memories)
            .where(and(eq(memories.kind, memory.kind), eq(memories.status, "active")))
            .all()
            .some((other) => other.id !== memory.replacesId && sameMemoryText(other.text, memory.text));
          if (staleTarget || duplicate) {
            tx.delete(memories).where(eq(memories.id, memory.id)).run();
            continue;
          }
          if (memory.replacesId) tx.update(memories).set({ status: "superseded" }).where(eq(memories.id, memory.replacesId)).run();
          tx.update(memories).set({ status: "active" }).where(eq(memories.id, memory.id)).run();
        }
      });
    },

    /** Saves a validated artifact produced by a tool call in a run. */
    createArtifact(input: { sessionId: string; runId: string; toolCallId: string; kind: string; version: number; spec: unknown }): ArtifactRow {
      const row = { id: randomUUID(), ...input, createdAt: new Date() };
      db.insert(artifacts).values(row).run();
      return row;
    },

    /** The artifact plus the status of the run that produced it. */
    findArtifact(id: string): (ArtifactRow & { runStatus: RunStatus }) | undefined {
      const row = db
        .select({ artifact: artifacts, runStatus: runs.status })
        .from(artifacts)
        .innerJoin(runs, eq(runs.id, artifacts.runId))
        .where(eq(artifacts.id, id))
        .get();
      return row && { ...row.artifact, runStatus: row.runStatus };
    },

    findAttempt(artifactId: string): AttemptRow | undefined {
      return db.select().from(attempts).where(eq(attempts.artifactId, artifactId)).get();
    },

    /** The learner's most recent graded attempts across all sessions, newest first. Rowid breaks timestamp ties. */
    listRecentEvidence(limit: number): EvidenceRow[] {
      return db
        .select({ id: attempts.id, concept: attempts.concept, correct: attempts.correct, createdAt: attempts.createdAt })
        .from(attempts)
        .orderBy(desc(attempts.createdAt), desc(sql`rowid`))
        .limit(limit)
        .all();
    },

    /**
     * Saves a memory written during a run; it is reconsidered when the run completes. Repeating a known
     * memory returns the existing one.
     */
    saveMemory(
      input: Pick<MemoryRow, "sessionId" | "runId" | "kind" | "text" | "concept" | "basis" | "attemptId"> & { replaces: string | null },
    ): { ok: true; memory: MemoryRow } | { ok: false; reason: string } {
      return db.transaction((tx) => {
        const { replaces, ...fields } = input;
        if (replaces && tx.select({ status: memories.status }).from(memories).where(eq(memories.id, replaces)).get()?.status !== "active") {
          return { ok: false, reason: "replaces isn't a known memory id" };
        }
        const ofThisRun = and(eq(memories.status, "pending"), eq(memories.runId, input.runId!));
        if (!replaces) {
          const known = tx
            .select()
            .from(memories)
            .where(and(eq(memories.kind, input.kind), or(eq(memories.status, "active"), ofThisRun)))
            .all();
          const existing = known.find((m) => sameMemoryText(m.text, input.text));
          if (existing) return { ok: true, memory: existing };
        }
        if (tx.select({ id: memories.id }).from(memories).where(ofThisRun).all().length >= MAX_MEMORIES_PER_RUN) {
          return { ok: false, reason: `A reply can save at most ${MAX_MEMORIES_PER_RUN} memories` };
        }
        const row = { id: randomUUID(), ...fields, status: "pending" as const, replacesId: replaces, createdAt: new Date(), editedAt: null };
        tx.insert(memories).values(row).run();
        return { ok: true, memory: row };
      });
    },

    /** Memories in force for the learner to see, newest first, each marked if it is held. */
    listMemoriesForLearner(checkKinds: string[]): (MemoryRow & { held: boolean })[] {
      return db
        .select({ memory: memories, held: heldBy(checkKinds) })
        .from(memories)
        .where(eq(memories.status, "active"))
        .orderBy(desc(memories.createdAt), desc(sql`rowid`))
        .all()
        .map((row) => ({ ...row.memory, held: Boolean(row.held) }));
    },

    /** Memories in force for the model to see, newest first, leaving out held ones. */
    listMemoriesForModel(checkKinds: string[], limit: number): MemoryRow[] {
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.status, "active"), sql`not ${heldBy(checkKinds)}`))
        .orderBy(desc(memories.createdAt), desc(sql`rowid`))
        .limit(limit)
        .all();
    },

    /** The learner's correction of a memory. A held memory can't be edited, since editing would show its text. */
    editMemory(id: string, text: string, checkKinds: string[]): { ok: true; memory: MemoryRow & { held: boolean } } | { ok: false; reason: "not_found" | "held" } {
      return db.transaction((tx) => {
        const found = tx
          .select({ held: heldBy(checkKinds) })
          .from(memories)
          .where(and(eq(memories.id, id), eq(memories.status, "active")))
          .get();
        if (!found) return { ok: false, reason: "not_found" };
        if (found.held) return { ok: false, reason: "held" };
        const memory = tx.update(memories).set({ text, editedAt: new Date() }).where(eq(memories.id, id)).returning().get();
        return { ok: true, memory: { ...memory, held: false } };
      });
    },

    /** The most recent wrong answer whose concept matches, however old. */
    findLatestWrongAnswer(matches: (concept: string) => boolean): Pick<AttemptRow, "id"> | undefined {
      return db
        .select({ id: attempts.id, concept: attempts.concept })
        .from(attempts)
        .where(and(eq(attempts.correct, false), isNotNull(attempts.concept)))
        .orderBy(desc(attempts.createdAt), desc(sql`rowid`))
        .all()
        .find((attempt) => matches(attempt.concept!));
    },

    /** Permanently deletes a memory and the earlier versions it replaced. Returns false unless it is active. */
    deleteMemory(id: string): boolean {
      return db.transaction((tx) => {
        let current = tx.select().from(memories).where(and(eq(memories.id, id), eq(memories.status, "active"))).get();
        if (!current) return false;
        while (current) {
          tx.delete(memories).where(eq(memories.id, current.id)).run();
          const replaced: string | null = current.replacesId;
          current = replaced ? tx.select().from(memories).where(eq(memories.id, replaced)).get() : undefined;
        }
        return true;
      });
    },

    /** Records the learner's single graded attempt. Throws Conflict if one already exists. */
    createAttempt(input: { artifactId: string; sessionId: string; answer: unknown; grade: unknown; correct: boolean; concept?: string }): AttemptRow {
      return db.transaction((tx) => {
        if (tx.select({ id: attempts.id }).from(attempts).where(eq(attempts.artifactId, input.artifactId)).get()) {
          throw new Conflict("This check has already been answered");
        }
        const row = { id: randomUUID(), ...input, concept: input.concept ?? null, createdAt: new Date() };
        tx.insert(attempts).values(row).run();
        return row;
      });
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
