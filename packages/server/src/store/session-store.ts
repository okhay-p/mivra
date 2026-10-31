import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { and, asc, desc, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { artifacts, attempts, messages, runs, sessions, type RunStatus } from "../db/schema.js";

export type { RunStatus };

export type SessionRow = typeof sessions.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;

/** A write was refused because it would break an invariant (reused message id, overlapping run). */
export class Conflict extends Error {}

const DEFAULT_TITLE = "New session";

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

    /** The learner's most recent graded attempts across all sessions, newest first. */
    listRecentAttempts(limit: number): AttemptRow[] {
      return db.select().from(attempts).orderBy(desc(attempts.createdAt)).limit(limit).all();
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
