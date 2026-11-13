import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { and, asc, desc, eq, inArray, isNull, isNotNull, max, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { ModelSelection } from "../model.js";
import { artifacts, attempts, courses, documentChunks, documents, lessons, memories, messages, notes, runs, sessions, syllabusVersions, vaultImports, type RunStatus } from "../db/schema.js";

export type { RunStatus };

export type SessionRow = typeof sessions.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type AttemptRow = typeof attempts.$inferSelect;
export type EvidenceRow = Pick<AttemptRow, "id" | "concept" | "correct" | "createdAt"> & Partial<Pick<AttemptRow, "judge">>;
export type MemoryRow = typeof memories.$inferSelect;
/** The imported note a memory was drawn from. */
export type MemorySource = { noteId: string; importId: string; importName: string; path: string; title: string };
export type DocumentRow = typeof documents.$inferSelect;
export type CourseRow = typeof courses.$inferSelect;
export type SyllabusRow = typeof syllabusVersions.$inferSelect;
export type SyllabusTopicRow = { id: string; title: string; summary: string; reason: string; requestedByLearner: boolean; concepts: string[] };
export type KnownConceptRow = { concept: string; source: "memory" | "test" | "guess"; note: string };
export type SyllabusVersion = Omit<SyllabusRow, "topics" | "known" | "changedTopicIds"> & { topics: SyllabusTopicRow[]; known: KnownConceptRow[]; changedTopicIds: string[] };
/** One edit of a syllabus's future topics. */
export type SyllabusOperation =
  | { op: "insert"; afterTopicId: string | null; title: string; summary: string; reason: string; concepts: string[] }
  | { op: "edit"; topicId: string; title?: string; summary?: string }
  | { op: "remove"; topicId: string }
  | { op: "move"; topicId: string; afterTopicId: string | null }
  | { op: "split"; topicId: string; into: { title: string; summary: string; concepts: string[] }[] };
/** A chunk of a document's text with what's needed to cite it. `documentOrder` is the document's rowid, so its upload order. */
export type DocumentExcerpt = { documentId: string; filename: string; kind: DocumentRow["kind"]; page: number; seq: number; text: string; documentOrder: number };

/** What a stored reply carries besides its parts. */
export type ReplyMetadata = { model?: string; /** Server-side only: a custom provider's endpoint fingerprint (issue #69). */ endpoint?: string };

/** A write was refused because it would break an invariant (reused message id, overlapping run). */
export class Conflict extends Error {}

const DEFAULT_TITLE = "New session";
/** Most memories one reply can write. */
const MAX_MEMORIES_PER_RUN = 5;
/** One initial continuation plus at most two navigation-triggered retries per quiz claim. */
const MAX_CONTINUATION_ATTEMPTS = 3;
const CONTINUATION_RETRY_COOLDOWN_MS = 30_000;

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
 * All persistence for sessions, messages and runs. With lesson-store.ts and note-store.ts, the only code that talks to Drizzle
 * (ADR-007), so the storage engine and schema can change without touching the runtime or routes.
 */
/** The session's id, then the ids of its course's lesson sessions, if it is a course. */
function ownedSessionIds(db: Pick<Db, "select">, id: string): string[] {
  const lessonSessions = db
    .select({ id: lessons.sessionId })
    .from(lessons)
    .innerJoin(courses, eq(courses.id, lessons.courseId))
    .where(eq(courses.sessionId, id))
    .all()
    .map((row) => row.id);
  return [id, ...lessonSessions];
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Inserts or replaces an artifact's attempt by one judge, keeping its id. */
function replaceIn(
  tx: Tx,
  input: { artifactId: string; sessionId: string; answer: unknown; grade: unknown; correct: boolean; concept?: string | null; judge: AttemptRow["judge"] },
  createdAt = new Date(),
): AttemptRow {
  const existing = tx.select({ id: attempts.id }).from(attempts).where(and(eq(attempts.artifactId, input.artifactId), eq(attempts.judge, input.judge))).get();
  const values = { answer: input.answer, grade: input.grade, correct: input.correct, concept: input.concept ?? null, createdAt };
  if (existing) {
    tx.update(attempts).set(values).where(eq(attempts.id, existing.id)).run();
    return { id: existing.id, artifactId: input.artifactId, sessionId: input.sessionId, judge: input.judge, ...values };
  }
  const row = { id: randomUUID(), artifactId: input.artifactId, sessionId: input.sessionId, judge: input.judge, ...values };
  tx.insert(attempts).values(row).run();
  return row;
}

export function createSessionStore(db: Db, clock: () => Date = () => new Date()) {
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
  const nextSeq = (tx: Tx, sessionId: string) =>
    (tx.select({ value: max(messages.seq) }).from(messages).where(eq(messages.sessionId, sessionId)).get()?.value ?? 0) + 1;

  return {
    /** Marks runs left running by a previous server process as failed. */
    recoverInterruptedRuns() {
      db.update(runs)
        .set({ status: "failed", error: "The server stopped before the reply finished", endedAt: clock() })
        .where(eq(runs.status, "running"))
        .run();
      // Their replies never completed, so neither did anything they tried to remember.
      db.delete(memories).where(eq(memories.status, "pending")).run();
    },

    /** Sessions, most recent first, with the course each one teaches, if any. A lesson's own session is hidden. */
    listSessions(): (SessionRow & { courseId: string | null; icon: string | null })[] {
      return db
        .select({ session: sessions, courseId: courses.id, icon: courses.icon })
        .from(sessions)
        .leftJoin(courses, eq(courses.sessionId, sessions.id))
        .leftJoin(lessons, eq(lessons.sessionId, sessions.id))
        .where(isNull(lessons.id))
        .orderBy(desc(sessions.updatedAt))
        .all()
        .map((row) => ({ ...row.session, courseId: row.courseId, icon: row.icon }));
    },

    /** Starts a course in a new session of its own, titled after the goal. */
    createCourse(goal: string, kind: CourseRow["kind"] = "lessons"): { course: CourseRow; session: SessionRow } {
      return db.transaction((tx) => {
        const now = clock();
        const session = { id: randomUUID(), title: goal.trim().slice(0, 60), titleSetByLearner: false, createdAt: now, updatedAt: now };
        tx.insert(sessions).values(session).run();
        const course = { id: randomUUID(), sessionId: session.id, goal: goal.trim(), kind, status: "interviewing" as const, icon: null, createdAt: now, updatedAt: now };
        tx.insert(courses).values(course).run();
        return { course, session };
      });
    },

    /**
     * Undoes the latest syllabus version if it was an automatic change and none of the topics it added or
     * moved has a lesson yet: a new version with the topics as they were before it (ADR-011).
     */
    undoSyllabusChange(courseId: string, version: number, startedTopicIds: string[]): { ok: true; version: number } | { ok: false; reason: string } {
      return db.transaction((tx) => {
        const rows = tx.select().from(syllabusVersions).where(eq(syllabusVersions.courseId, courseId)).orderBy(desc(syllabusVersions.version)).limit(2).all();
        const [latest, before] = rows;
        if (!latest || latest.version !== version) return { ok: false, reason: "Only the latest change can be undone." };
        if (latest.source !== "adaptive" || !before) return { ok: false, reason: "Only an automatic change can be undone." };
        const started = new Set(startedTopicIds);
        if ((latest.changedTopicIds as string[]).some((id) => started.has(id))) return { ok: false, reason: "A lesson from that change has already started." };
        const now = clock();
        tx.insert(syllabusVersions)
          .values({
            id: randomUUID(),
            courseId,
            version: latest.version + 1,
            topics: before.topics,
            known: latest.known,
            source: "undo",
            triggerLessonId: null,
            reason: `Undid: ${latest.reason ?? "the automatic change"}`,
            changedTopicIds: [],
            runId: null,
            createdAt: now,
          })
          .run();
        tx.update(courses).set({ updatedAt: now }).where(eq(courses.id, courseId)).run();
        return { ok: true, version: latest.version + 1 };
      });
    },

    /**
     * The last message of a course's placement interview: the stored reply of the run that wrote the first
     * syllabus, or, if that run stored no reply (it failed after writing it), the last message stored before
     * the syllabus was written. Null only while there is no syllabus.
     */
    interviewMessageId(courseId: string): string | null {
      const syllabus = db
        .select({ runId: syllabusVersions.runId, createdAt: syllabusVersions.createdAt, sessionId: courses.sessionId })
        .from(syllabusVersions)
        .innerJoin(courses, eq(courses.id, syllabusVersions.courseId))
        .where(and(eq(syllabusVersions.courseId, courseId), eq(syllabusVersions.version, 1)))
        .get();
      if (!syllabus) return null;
      const reply = syllabus.runId
        ? db.select({ id: runs.assistantMessageId }).from(runs).where(eq(runs.id, syllabus.runId)).get()?.id
        : undefined;
      if (reply) return reply;
      const before = db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.sessionId, syllabus.sessionId), sql`${messages.createdAt} <= ${syllabus.createdAt.getTime()}`))
        .orderBy(desc(messages.seq))
        .get();
      return before?.id ?? null;
    },

    /** Whether an automatic syllabus change was already made after a finished lesson. */
    hasAdaptiveChange(courseId: string, triggerLessonId: string): boolean {
      return Boolean(
        db
          .select({ id: syllabusVersions.id })
          .from(syllabusVersions)
          .where(and(eq(syllabusVersions.courseId, courseId), eq(syllabusVersions.triggerLessonId, triggerLessonId)))
          .get(),
      );
    },

    /** Marks an active course complete: the learner reached the end of its syllabus (ADR-011). */
    completeCourse(courseId: string) {
      db.update(courses).set({ status: "complete", updatedAt: clock() }).where(and(eq(courses.id, courseId), eq(courses.status, "active"))).run();
    },

    findCourse(id: string): CourseRow | undefined {
      return db.select().from(courses).where(eq(courses.id, id)).get();
    },

    findCourseBySession(sessionId: string): CourseRow | undefined {
      return db.select().from(courses).where(eq(courses.sessionId, sessionId)).get();
    },

    /** The course's newest syllabus version, if one has been written. */
    latestSyllabus(courseId: string): SyllabusVersion | undefined {
      const row = db.select().from(syllabusVersions).where(eq(syllabusVersions.courseId, courseId)).orderBy(desc(syllabusVersions.version)).get();
      return row && { ...row, topics: row.topics as SyllabusTopicRow[], known: row.known as KnownConceptRow[], changedTopicIds: row.changedTopicIds as string[] };
    },

    /**
     * Changes a course's future topics as a new syllabus version (ADR-011). `startedTopicIds` are topics
     * that already have a lesson: they stay where they are, and nothing may be inserted before them.
     * All operations apply, or none.
     */
    changeSyllabus(
      courseId: string,
      change: {
        source: "tutor" | "adaptive";
        reason: string;
        runId: string | null;
        startedTopicIds: string[];
        operations: SyllabusOperation[];
        /** For an adaptive change: the finished lesson that prompted it. Only one change per lesson. */
        triggerLessonId?: string;
      },
    ): { ok: true; version: number; changedTopicIds: string[] } | { ok: false; reason: string } {
      return db.transaction((tx) => {
        const row = tx.select().from(syllabusVersions).where(eq(syllabusVersions.courseId, courseId)).orderBy(desc(syllabusVersions.version)).get();
        if (!row) return { ok: false, reason: "The course has no syllabus yet." };
        // A course that is complete (perhaps by a finish racing this change) keeps its syllabus.
        if (tx.select({ status: courses.status }).from(courses).where(eq(courses.id, courseId)).get()?.status !== "active") {
          return { ok: false, reason: "The course is complete, so its syllabus can't change." };
        }
        if (change.source === "adaptive") {
          if (!change.triggerLessonId) return { ok: false, reason: "An automatic change needs the lesson that prompted it." };
          const earlier = tx
            .select({ id: syllabusVersions.id })
            .from(syllabusVersions)
            .where(and(eq(syllabusVersions.courseId, courseId), eq(syllabusVersions.triggerLessonId, change.triggerLessonId)))
            .get();
          if (earlier) return { ok: false, reason: "The plan was already changed once after that lesson." };
        }
        const started = new Set(change.startedTopicIds);
        let topics = [...(row.topics as SyllabusTopicRow[])];
        const changed = new Set<string>();
        const firstFuture = () => topics.findIndex((t) => !started.has(t.id));
        const future = (id: string) => {
          const i = topics.findIndex((t) => t.id === id);
          if (i < 0) return { error: `Unknown topicId ${id}` };
          if (started.has(id)) return { error: "Only future topics can change: this one already has a lesson." };
          return { index: i };
        };
        const insertionPoint = (afterTopicId: string | null) => {
          const lastStarted = topics.reduce((last, t, i) => (started.has(t.id) ? i : last), -1);
          if (afterTopicId === null) return { at: lastStarted + 1 };
          const i = topics.findIndex((t) => t.id === afterTopicId);
          if (i < 0) return { error: `Unknown afterTopicId ${afterTopicId}` };
          if (i < lastStarted) return { error: "New topics can only go after the lessons already started." };
          return { at: i + 1 };
        };
        for (const op of change.operations) {
          if (op.op === "insert") {
            const point = insertionPoint(op.afterTopicId);
            if ("error" in point) return { ok: false, reason: point.error! };
            const topic = { id: randomUUID(), title: op.title, summary: op.summary, reason: op.reason, requestedByLearner: change.source === "tutor", concepts: op.concepts };
            topics.splice(point.at, 0, topic);
            changed.add(topic.id);
            continue;
          }
          const found = future(op.topicId);
          if ("error" in found) return { ok: false, reason: found.error! };
          if (op.op === "split") {
            const topic = topics[found.index]!;
            const parts = op.into.map((part) => ({
              id: randomUUID(),
              ...part,
              reason: change.reason,
              requestedByLearner: topic.requestedByLearner,
            }));
            topics.splice(found.index, 1, ...parts);
            parts.forEach((p) => changed.add(p.id));
          } else if (op.op === "remove") {
            if (change.source === "adaptive" && topics[found.index]!.requestedByLearner) {
              return { ok: false, reason: "A topic the learner asked for is never removed automatically." };
            }
            topics.splice(found.index, 1);
          } else if (op.op === "edit") {
            const topic = topics[found.index]!;
            topics[found.index] = { ...topic, ...(op.title ? { title: op.title } : {}), ...(op.summary ? { summary: op.summary } : {}) };
            changed.add(topic.id);
          } else {
            const [topic] = topics.splice(found.index, 1);
            const point = insertionPoint(op.afterTopicId);
            if ("error" in point) return { ok: false, reason: point.error! };
            topics.splice(point.at, 0, topic!);
            changed.add(topic!.id);
          }
        }
        if (firstFuture() >= 0 && topics.slice(0, firstFuture()).some((t) => !started.has(t.id))) {
          return { ok: false, reason: "Started topics must stay first." };
        }
        const titles = new Set<string>();
        for (const t of topics) {
          const key = t.title.trim().toLowerCase();
          if (titles.has(key)) return { ok: false, reason: `Two topics would be called "${t.title}".` };
          titles.add(key);
        }
        if (topics.length === 0) return { ok: false, reason: "A syllabus needs at least one topic." };
        const version = row.version + 1;
        const changedTopicIds = topics.map((t) => t.id).filter((id) => changed.has(id));
        tx.insert(syllabusVersions)
          .values({
            id: randomUUID(),
            courseId,
            version,
            topics,
            known: row.known,
            source: change.source,
            triggerLessonId: change.triggerLessonId ?? null,
            reason: change.reason,
            changedTopicIds,
            runId: change.runId,
            createdAt: clock(),
          })
          .run();
        tx.update(courses).set({ updatedAt: clock() }).where(eq(courses.id, courseId)).run();
        return { ok: true, version, changedTopicIds };
      });
    },

    /**
     * Writes a course's first syllabus at the end of its placement interview, and makes the course active.
     * Returns false if the course isn't interviewing (its syllabus already exists); later versions come
     * from Change and adaptive edits, not from this. The tutor's `title` replaces the course's placeholder
     * title (its goal) unless the learner has renamed it, and its `icon` becomes the course's; both are
     * checked by the caller, and a missing one leaves things as they were (#58).
     */
    writeFirstSyllabus(
      courseId: string,
      runId: string | null,
      input: { topics: Omit<SyllabusTopicRow, "id">[]; known: KnownConceptRow[]; title?: string; icon?: string },
    ): SyllabusRow | undefined {
      return db.transaction((tx) => {
        const course = tx.select().from(courses).where(eq(courses.id, courseId)).get();
        if (course?.status !== "interviewing") return undefined;
        const now = clock();
        const row = {
          id: randomUUID(),
          courseId,
          version: 1,
          topics: input.topics.map((topic) => ({ id: randomUUID(), ...topic })),
          known: input.known,
          source: "interview" as const,
          triggerLessonId: null,
          reason: null,
          changedTopicIds: [],
          runId,
          createdAt: now,
        };
        tx.insert(syllabusVersions).values(row).run();
        tx.update(courses)
          .set({ status: "active", ...(input.icon ? { icon: input.icon } : {}), updatedAt: now })
          .where(eq(courses.id, courseId))
          .run();
        if (input.title) {
          tx.update(sessions)
            .set({ title: input.title })
            .where(and(eq(sessions.id, course.sessionId), eq(sessions.titleSetByLearner, false)))
            .run();
        }
        return row;
      });
    },

    createSession(title?: string): SessionRow {
      const now = new Date();
      const row = { id: randomUUID(), title: title ?? DEFAULT_TITLE, titleSetByLearner: false, createdAt: now, updatedAt: now };
      db.insert(sessions).values(row).run();
      return row;
    },

    /**
     * Gives a session the learner's title, which automatic titling then never replaces. It isn't counted
     * as activity, so the session keeps its place in the sidebar. Undefined if there's no such session.
     */
    renameSession(id: string, title: string): SessionRow | undefined {
      return db.update(sessions).set({ title, titleSetByLearner: true }).where(eq(sessions.id, id)).returning().get();
    },

    findSession(id: string): SessionRow | undefined {
      return db.select().from(sessions).where(eq(sessions.id, id)).get();
    },

    /** The session and, for a course, every lesson's own session: everything deleting it removes. */
    ownedSessionIds(id: string): string[] {
      return ownedSessionIds(db, id);
    },

    /**
     * Deletes a session with everything that belongs only to it, in one transaction. For a course that
     * includes each lesson's own session, which the course's cascade alone would leave behind. Memories
     * are kept (their session_id becomes null), except those still pending on one of its runs.
     * Returns the deleted session ids, or undefined if there was no such session.
     */
    deleteSession(id: string): string[] | undefined {
      return db.transaction((tx) => {
        if (!tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get()) return undefined;
        const ids = ownedSessionIds(tx, id);
        // A pending memory waits on its run to finish; with the run gone it never would.
        const runIds = tx.select({ id: runs.id }).from(runs).where(inArray(runs.sessionId, ids)).all().map((r) => r.id);
        if (runIds.length > 0) tx.delete(memories).where(and(eq(memories.status, "pending"), inArray(memories.runId, runIds))).run();
        // Lesson sessions first: once the course cascade runs, the lessons that name them are gone.
        tx.delete(sessions).where(inArray(sessions.id, ids.slice(1))).run();
        tx.delete(sessions).where(eq(sessions.id, id)).run();
        return ids;
      });
    },

    /** Messages in conversation order. A reply's metadata names the model that wrote it, when that was recorded (ADR-012). */
    loadMessages(sessionId: string, forModel = false): UIMessage<ReplyMetadata>[] {
      const replyRuns = db.select({ id: runs.assistantMessageId, status: runs.status, model: runs.model, endpoint: runs.endpoint }).from(runs)
        .where(and(eq(runs.sessionId, sessionId), isNotNull(runs.assistantMessageId))).all();
      // Cancelled replies are display-only: never replay truncated turns as complete answers.
      const cancelled = new Set(forModel ? replyRuns.filter((run) => run.status === "cancelled").map((run) => run.id) : []);
      const models = new Map(replyRuns.flatMap((run) => (run.model ? [[run.id, { model: run.model, ...(run.endpoint ? { endpoint: run.endpoint } : {}) }] as const] : [])));
      return db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.seq))
        .all()
        .filter((row) => !cancelled.has(row.id))
        .map((row) => {
          const metadata = models.get(row.id);
          return { id: row.id, role: row.role, parts: row.parts as UIMessage["parts"], ...(metadata ? { metadata } : {}) };
        });
    },

    /**
     * Saves the user message and claims the session's single running slot, atomically.
     * Throws Conflict if the message id was used before or a run is already in progress.
     */
    startRun(session: SessionRow, message: UIMessage, selection?: ModelSelection): string {
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
          .values({ id: runId, sessionId: session.id, userMessageId: message.id, status: "running", startedAt: now, model: selection?.model, effort: selection?.effort, endpoint: selection?.endpoint })
          .run();

        const title = seq === 1 && session.title === DEFAULT_TITLE && !session.titleSetByLearner ? firstText(message)?.trim().slice(0, 60) : undefined;
        tx.update(sessions)
          .set({ updatedAt: now, ...(title ? { title } : {}) })
          .where(eq(sessions.id, session.id))
          .run();
        return runId;
      });
    },

    latestRun(sessionId: string) {
      return db.select().from(runs).where(eq(runs.sessionId, sessionId)).orderBy(desc(sql`rowid`)).get();
    },

    /** Claims an automatic continuation once, only for the latest completed, fully answered quiz reply. */
    startContinuation(sessionId: string, checkKinds: string[], selection?: ModelSelection) {
      return db.transaction(tx => {
        const latest = tx.select().from(runs).where(eq(runs.sessionId, sessionId)).orderBy(desc(sql`rowid`)).get();
        // Keep failed attempts (and their errors), but transfer their unique logical claim to a
        // fresh run. A newer learner turn, cancellation or completion must never be retried.
        const retry = latest?.status === "failed" && latest.continuationOf ? latest : undefined;
        const source = retry
          ? tx.select().from(runs).where(eq(runs.id, retry.continuationOf!)).get()
          : latest;
        const latestCompleted = tx.select({ id: runs.id }).from(runs)
          .where(and(eq(runs.sessionId, sessionId), eq(runs.status, "completed"))).orderBy(desc(sql`rowid`)).get();
        if (source?.id !== latestCompleted?.id) return;
        if (!source || source.status !== "completed" || checkKinds.length === 0) return;
        const checks = tx.select().from(artifacts).where(and(eq(artifacts.runId, source.id), inArray(artifacts.kind, checkKinds))).all();
        if (checks.length === 0 || checks.some(a => !tx.select({ id: attempts.id }).from(attempts).where(eq(attempts.artifactId, a.id)).get())) return;
        const startedAt = clock();
        if (retry) {
          // Transferred claims clear continuationOf, but every attempt remains after its source
          // in rowid order. No learner turn can intervene without superseding this claim.
          const { count } = tx.select({ count: sql<number>`count(*)` }).from(runs).where(and(
            eq(runs.sessionId, sessionId),
            sql`rowid > (select rowid from runs where id = ${source.id})`,
          )).get()!;
          if (count >= MAX_CONTINUATION_ATTEMPTS || !retry.endedAt || startedAt.getTime() - retry.endedAt.getTime() < CONTINUATION_RETRY_COOLDOWN_MS) return;
        }
        if (retry) tx.update(runs).set({ continuationOf: null }).where(eq(runs.id, retry.id)).run();
        if (tx.select({ id: runs.id }).from(runs).where(eq(runs.continuationOf, source.id)).get()) return;
        const row = { id: randomUUID(), sessionId, userMessageId: source.userMessageId,
          continuationOf: source.id, status: "running" as const, startedAt, model: selection?.model, effort: selection?.effort, endpoint: selection?.endpoint };
        tx.insert(runs).values(row).run();
        return row;
      });
    },

    /**
     * Records how a run ended. Cancelled text is saved for display, but excluded from model history.
     * Only completed tool calls belong in a durable model transcript.
     */
    finishRun(runId: string, sessionId: string, status: RunStatus, reply?: UIMessage, error?: string) {
      db.transaction((tx) => {
        // The session may have been deleted while this run was stopping; then there's nothing to record.
        if (!tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get()) return;
        const now = clock();
        let assistantMessageId: string | undefined;
        if (status === "cancelled" && reply) {
          reply = { ...reply, parts: reply.parts.filter((part) => part.type === "text" || part.type === "reasoning")
            .map((part) => ({ ...part, state: "done" })) };
        }
        if ((status === "completed" || status === "cancelled") && reply && reply.parts.length > 0) {
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
        const startedAt = tx.select({ startedAt: runs.startedAt }).from(runs).where(eq(runs.id, runId)).get()!.startedAt;
        for (const memory of tx.select().from(memories).where(pending).orderBy(sql`rowid`).all()) {
          const target = memory.replacesId ? tx.select().from(memories).where(eq(memories.id, memory.replacesId)).get() : undefined;
          // The model read its context when the run started, so it can't have seen an edit made since then.
          const staleTarget = memory.replacesId && (target?.status !== "active" || (target.editedAt && target.editedAt >= startedAt));
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

    /** The learner's attempt as the deterministic grader judged it (for a milestone, its latest check). */
    findAttempt(artifactId: string): AttemptRow | undefined {
      return db.select().from(attempts).where(and(eq(attempts.artifactId, artifactId), eq(attempts.judge, "grader"))).get();
    },

    /** A project milestone's latest review verdict: the attempt a model judged (ADR-016). */
    findReview(artifactId: string): AttemptRow | undefined {
      return db.select().from(attempts).where(and(eq(attempts.artifactId, artifactId), eq(attempts.judge, "model"))).get();
    },

    /** Replaces an artifact's stored spec, as a dispute's outcome does to a milestone (ADR-016). */
    updateArtifactSpec(id: string, spec: unknown) {
      db.update(artifacts).set({ spec }).where(eq(artifacts.id, id)).run();
    },

    /** The learner's most recent graded attempts across all sessions, newest first. Rowid breaks timestamp ties. */
    listRecentEvidence(limit: number): EvidenceRow[] {
      return db
        .select({ id: attempts.id, concept: attempts.concept, correct: attempts.correct, createdAt: attempts.createdAt, judge: attempts.judge })
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
        const row = { id: randomUUID(), ...fields, status: "pending" as const, replacesId: replaces, noteId: null, createdAt: new Date(), editedAt: null };
        tx.insert(memories).values(row).run();
        return { ok: true, memory: row };
      });
    },

    /** Memories in force for the learner to see, newest first, each marked if it is held, with the note it came from. */
    listMemoriesForLearner(checkKinds: string[]): (MemoryRow & { held: boolean; source: MemorySource | null })[] {
      return db
        .select({ memory: memories, held: heldBy(checkKinds), note: { path: notes.path, title: notes.title, importId: notes.importId }, importName: vaultImports.name })
        .from(memories)
        .leftJoin(notes, eq(notes.id, memories.noteId))
        .leftJoin(vaultImports, eq(vaultImports.id, notes.importId))
        .where(eq(memories.status, "active"))
        .orderBy(desc(memories.createdAt), desc(sql`"memories"."rowid"`))
        .all()
        .map((row) => ({
          ...row.memory,
          held: Boolean(row.held),
          source: row.memory.noteId && row.note ? { noteId: row.memory.noteId, importId: row.note.importId, importName: row.importName ?? "", path: row.note.path, title: row.note.title } : null,
        }));
    },

    /**
     * Memories in force for the model to see, newest first, leaving out held ones. Those drawn from imported notes are
     * listed apart (listImportedMemoriesForModel), so a large vault can't crowd out what the learner said or got wrong.
     */
    listMemoriesForModel(checkKinds: string[], limit: number): MemoryRow[] {
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.status, "active"), ne(memories.basis, "import"), sql`not ${heldBy(checkKinds)}`))
        .orderBy(desc(memories.createdAt), desc(sql`rowid`))
        .limit(limit)
        .all();
    },

    /** Memories drawn from imported notes, for the model: goals and misconceptions first, then `known`, newest first. */
    listImportedMemoriesForModel(limit: number): MemoryRow[] {
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.status, "active"), eq(memories.basis, "import")))
        .orderBy(sql`case ${memories.kind} when 'known' then 1 else 0 end`, desc(memories.createdAt), desc(sql`rowid`))
        .limit(limit)
        .all();
    },

    /** Permanently deletes every memory with a basis, such as all those drawn from imported notes. Returns how many. */
    deleteMemoriesByBasis(basis: MemoryRow["basis"]): number {
      return db.delete(memories).where(eq(memories.basis, basis)).run().changes;
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

    /**
     * Saves a document and its text together; triggers index the text for search. Throws Conflict if the
     * session already has `maxDocuments`, which other uploads may have filled since this one started.
     */
    createDocument(
      input: Pick<DocumentRow, "sessionId" | "filename" | "kind" | "byteSize" | "textChars" | "pageCount" | "pagesWithText">,
      chunks: { page: number; seq: number; text: string }[],
      maxDocuments: number,
    ): DocumentRow {
      return db.transaction((tx) => {
        if (tx.select({ id: documents.id }).from(documents).where(eq(documents.sessionId, input.sessionId)).all().length >= maxDocuments) {
          throw new Conflict(`A session can have at most ${maxDocuments} documents`);
        }
        const row = { id: randomUUID(), ...input, messageId: null, status: "ready" as const, createdAt: new Date() };
        tx.insert(documents).values(row).run();
        for (const chunk of chunks) tx.insert(documentChunks).values({ documentId: row.id, ...chunk }).run();
        return row;
      });
    },

    /** Display association only; retrieval remains session-wide. Never reassign an earlier attachment. */
    bindDocuments(sessionId: string, messageId: string, ids: string[]) {
      if (ids.length === 0) return;
      db.update(documents).set({ messageId })
        .where(and(eq(documents.sessionId, sessionId), isNull(documents.messageId), inArray(documents.id, ids))).run();
    },

    /** A session's documents in upload order. */
    listDocuments(sessionId: string): DocumentRow[] {
      return db.select().from(documents).where(eq(documents.sessionId, sessionId)).orderBy(asc(sql`rowid`)).all();
    },

    /** Deletes a document; its chunks follow by cascade and triggers remove them from search. Returns false if unknown. */
    deleteDocument(id: string): boolean {
      return db.delete(documents).where(eq(documents.id, id)).run().changes > 0;
    },

    /** The session's chunks matching an FTS5 query, best first, from one document if given. The query must already be safe: see ftsQuery. */
    searchDocumentChunks(sessionId: string, query: string, limit: number, documentId?: string): DocumentExcerpt[] {
      return db.all<DocumentExcerpt>(sql`
        select d.id as documentId, d.filename, d.kind, c.page, c.seq, c.text, d.rowid as documentOrder
        from document_chunks_fts f
        join document_chunks c on c.id = f.rowid
        join documents d on d.id = c.document_id
        where document_chunks_fts match ${query} and d.session_id = ${sessionId}${documentId ? sql` and d.id = ${documentId}` : sql``}
        order by f.rank
        limit ${limit}`);
    },

    /** Each of the session's documents from its start, taking turns so one long document can't crowd out the others; or just one document, if given. */
    firstDocumentChunks(sessionId: string, limit: number, documentId?: string): DocumentExcerpt[] {
      return db.all<DocumentExcerpt>(sql`
        select d.id as documentId, d.filename, d.kind, c.page, c.seq, c.text, d.rowid as documentOrder
        from document_chunks c
        join documents d on d.id = c.document_id
        where d.session_id = ${sessionId}${documentId ? sql` and d.id = ${documentId}` : sql``}
        order by c.seq, d.rowid
        limit ${limit}`);
    },

    /** One page or slide of a document, in reading order. */
    documentPageChunks(documentId: string, page: number, limit: number): DocumentExcerpt[] {
      return db.all<DocumentExcerpt>(sql`
        select d.id as documentId, d.filename, d.kind, c.page, c.seq, c.text, d.rowid as documentOrder
        from document_chunks c
        join documents d on d.id = c.document_id
        where c.document_id = ${documentId} and c.page = ${page}
        order by c.seq
        limit ${limit}`);
    },

    /** Records the learner's single graded attempt. Throws Conflict if one already exists. */
    createAttempt(input: { artifactId: string; sessionId: string; answer: unknown; grade: unknown; correct: boolean; concept?: string | null }): AttemptRow {
      return db.transaction((tx) => {
        if (tx.select({ id: attempts.id }).from(attempts).where(and(eq(attempts.artifactId, input.artifactId), eq(attempts.judge, "grader"))).get()) {
          throw new Conflict("This check has already been answered");
        }
        const row = { id: randomUUID(), ...input, concept: input.concept ?? null, judge: "grader" as const, createdAt: new Date() };
        tx.insert(attempts).values(row).run();
        return row;
      });
    },

    /**
     * Records a repeatable check's latest result (a project milestone's `mivra check`, ADR-016), replacing the one
     * before it, so the attempt and its evidence are always the latest check. The last check's review goes with it:
     * a review belongs to the check it read.
     */
    replaceAttempt(input: { artifactId: string; sessionId: string; answer: unknown; grade: unknown; correct: boolean; concept?: string | null }): AttemptRow {
      return db.transaction((tx) => {
        tx.delete(attempts).where(and(eq(attempts.artifactId, input.artifactId), eq(attempts.judge, "model"))).run();
        return replaceIn(tx, { ...input, judge: "grader" }, clock());
      });
    },

    /**
     * Records a review verdict as the milestone's model-judged attempt, replacing the last, but only while `current`
     * says the check it read is still the latest (a newer check may have arrived while the model read this one).
     * Returns undefined if not.
     */
    saveReview(
      input: { artifactId: string; sessionId: string; answer: unknown; grade: unknown; correct: boolean; concept?: string | null },
      current: (check: AttemptRow | undefined) => boolean,
    ): AttemptRow | undefined {
      return db.transaction((tx) => {
        const check = tx.select().from(attempts).where(and(eq(attempts.artifactId, input.artifactId), eq(attempts.judge, "grader"))).get();
        if (!current(check)) return undefined;
        return replaceIn(tx, { ...input, judge: "model" }, clock());
      });
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
