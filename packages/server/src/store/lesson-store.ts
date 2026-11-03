import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { artifacts, attempts, lessonSections, lessonVersions, lessons, sessions } from "../db/schema.js";

export type LessonRow = typeof lessons.$inferSelect;

/** A change that would break the lesson's rules; thrown inside a transaction so it rolls back. */
class Refused extends Error {}
export type LessonSectionRow = typeof lessonSections.$inferSelect;
export type LessonOutline = { title: string; sections: { title: string; kind: string; purpose: string }[] };
export type LessonVersionRow = Omit<typeof lessonVersions.$inferSelect, "outline" | "sectionIds" | "changedSectionIds"> & {
  outline: LessonOutline;
  sectionIds: string[];
  changedSectionIds: string[];
};

/** One edit of a lesson, as the tutor's change_lesson tool or Add to lesson asks for it. */
export type LessonOperation =
  | { op: "rewrite"; sectionId: string; markdown: string; title?: string }
  | { op: "insert"; afterSectionId: string | null; title: string; markdown: string }
  | { op: "insert_artifact"; afterSectionId: string | null; title: string; artifactId: string; kind: string }
  | { op: "remove"; sectionId: string }
  | { op: "move"; sectionId: string; afterSectionId: string | null };

/**
 * Persistence for lessons (ADR-011). Like SessionStore, the only code that touches these tables.
 * Sections are immutable; a version is an outline plus an ordered list of section ids.
 */
export function createLessonStore(db: Db, clock: () => Date = () => new Date()) {
  const latestVersion = (lessonId: string): LessonVersionRow | undefined => {
    const row = db.select().from(lessonVersions).where(eq(lessonVersions.lessonId, lessonId)).orderBy(desc(lessonVersions.version)).get();
    return row && { ...row, outline: row.outline as LessonOutline, sectionIds: row.sectionIds as string[], changedSectionIds: row.changedSectionIds as string[] };
  };

  const listeners = new Set<(lessonId: string) => void>();
  const emit = (lessonId: string) => {
    for (const listener of listeners) listener(lessonId);
  };

  return {
    latestVersion,

    /** Calls `listener` after a lesson changes through a tutor's edit. */
    onChange(listener: (lessonId: string) => void) {
      listeners.add(listener);
    },

    /**
     * Starts the lesson for a topic, with a hidden session of its own for generation. Returns the existing
     * lesson if the topic already has one, so a repeated request can't start a second.
     */
    createLesson(input: { courseId: string; topicId: string; topicTitle: string; position: number }): { lesson: LessonRow; created: boolean } {
      return db.transaction((tx) => {
        const existing = tx.select().from(lessons).where(and(eq(lessons.courseId, input.courseId), eq(lessons.topicId, input.topicId))).get();
        if (existing) return { lesson: existing, created: false };
        const now = clock();
        const sessionId = randomUUID();
        tx.insert(sessions).values({ id: sessionId, title: `Lesson: ${input.topicTitle}`.slice(0, 60), createdAt: now, updatedAt: now }).run();
        const lesson = { id: randomUUID(), ...input, sessionId, status: "generating" as const, error: null, createdAt: now, finishedAt: null };
        tx.insert(lessons).values(lesson).run();
        return { lesson, created: true };
      });
    },

    findLesson(id: string): LessonRow | undefined {
      return db.select().from(lessons).where(eq(lessons.id, id)).get();
    },

    findLessonBySession(sessionId: string): LessonRow | undefined {
      return db.select().from(lessons).where(eq(lessons.sessionId, sessionId)).get();
    },

    listLessons(courseId: string): LessonRow[] {
      return db.select().from(lessons).where(eq(lessons.courseId, courseId)).orderBy(asc(lessons.position), asc(lessons.createdAt)).all();
    },

    /** Marks a failed lesson as generating again, to resume where it stopped. */
    restartLesson(id: string): boolean {
      return db.update(lessons).set({ status: "generating", error: null }).where(and(eq(lessons.id, id), eq(lessons.status, "failed"))).run().changes > 0;
    },

    /** Lessons left generating by a previous server process stopped part-way; they can be resumed. */
    recoverInterrupted() {
      db.update(lessons).set({ status: "failed", error: "The server stopped before the lesson was finished" }).where(eq(lessons.status, "generating")).run();
    },

    setStatus(id: string, status: "ready" | "failed", error?: string) {
      db.update(lessons)
        .set({ status, error: error ?? null })
        .where(and(eq(lessons.id, id), eq(lessons.status, "generating")))
        .run();
    },

    /** Writes version 1's outline. Returns false if the lesson already has one. */
    writeOutline(lessonId: string, outline: LessonOutline): boolean {
      return db.transaction((tx) => {
        if (tx.select({ id: lessonVersions.id }).from(lessonVersions).where(eq(lessonVersions.lessonId, lessonId)).get()) return false;
        tx.insert(lessonVersions).values({ id: randomUUID(), lessonId, version: 1, outline, sectionIds: [], createdAt: clock() }).run();
        return true;
      });
    },

    /** Appends a section to the version being generated. Refused once the outline is full or the lesson isn't generating. */
    appendSection(lessonId: string, section: Pick<LessonSectionRow, "kind" | "title" | "markdown" | "artifactId">): LessonSectionRow | undefined {
      return db.transaction((tx) => {
        const lesson = tx.select().from(lessons).where(eq(lessons.id, lessonId)).get();
        const version = latestVersion(lessonId);
        if (lesson?.status !== "generating" || !version || version.sectionIds.length >= version.outline.sections.length) return undefined;
        const row = { id: randomUUID(), lessonId, ...section, createdAt: clock() };
        tx.insert(lessonSections).values(row).run();
        tx.update(lessonVersions).set({ sectionIds: [...version.sectionIds, row.id] }).where(eq(lessonVersions.id, version.id)).run();
        return row;
      });
    },

    /**
     * Applies the tutor's edits to a lesson as a new version (ADR-011). Only a fully written lesson that
     * isn't finished can change; sections are never edited in place, so earlier versions and their
     * attempts stay as the learner saw them. All operations apply, or none.
     */
    changeLesson(lessonId: string, reason: string, operations: LessonOperation[]): { ok: true; version: number } | { ok: false; reason: string } {
      const result = this.applyChange(lessonId, reason, operations);
      if (result.ok) emit(lessonId);
      return result;
    },

    applyChange(lessonId: string, reason: string, operations: LessonOperation[]): { ok: true; version: number } | { ok: false; reason: string } {
      try {
        return this.applyChangeOrThrow(lessonId, reason, operations);
      } catch (error) {
        if (error instanceof Refused) return { ok: false, reason: error.message };
        throw error;
      }
    },

    /** Throws Refused, which rolls back any section already written. */
    applyChangeOrThrow(lessonId: string, reason: string, operations: LessonOperation[]): { ok: true; version: number } {
      const refuse = (message: string): never => {
        throw new Refused(message);
      };
      return db.transaction((tx) => {
        const lesson = tx.select().from(lessons).where(eq(lessons.id, lessonId)).get();
        if (lesson?.status === "finished") return refuse("This lesson is finished, so it can't change.");
        if (lesson?.status !== "ready") return refuse("This lesson is still being written.");
        const current = latestVersion(lessonId)!;
        const known = new Map(this.sections(current.sectionIds).map((s) => [s.id, s]));
        type Entry = { id: string; title: string; kind: string; purpose: string };
        const outlineById = new Map(current.sectionIds.map((id, i) => [id, current.outline.sections[i]!]));
        let entries: Entry[] = current.sectionIds.map((id) => ({ id, ...outlineById.get(id)! }));
        const changed = new Set<string>();
        // A rewritten section gets a new id; later operations may still name the one the tutor saw.
        const renamed = new Map<string, string>();
        const resolve = (id: string) => renamed.get(id) ?? id;
        const now = clock();
        const newSection = (section: Pick<LessonSectionRow, "kind" | "title" | "markdown" | "artifactId">) => {
          const row = { id: randomUUID(), lessonId, ...section, createdAt: now };
          tx.insert(lessonSections).values(row).run();
          changed.add(row.id);
          return row;
        };
        const position = (afterSectionId: string | null) => {
          if (afterSectionId === null) return 0;
          const i = entries.findIndex((e) => e.id === resolve(afterSectionId));
          return i < 0 ? undefined : i + 1;
        };
        for (const op of operations) {
          if (op.op === "insert" || op.op === "insert_artifact") {
            const at = position(op.afterSectionId);
            if (at === undefined) return refuse(`Unknown afterSectionId ${op.afterSectionId}`);
            const row =
              op.op === "insert"
                ? newSection({ kind: "prose", title: op.title, markdown: op.markdown, artifactId: null })
                : newSection({ kind: "artifact", title: op.title, markdown: null, artifactId: op.artifactId });
            entries.splice(at, 0, { id: row.id, title: op.title, kind: op.op === "insert" ? "prose" : op.kind, purpose: "Added by the tutor" });
            continue;
          }
          const i = entries.findIndex((e) => e.id === resolve(op.sectionId));
          if (i < 0) return refuse(`Unknown sectionId ${op.sectionId}`);
          if (op.op === "remove") {
            entries.splice(i, 1);
          } else if (op.op === "move") {
            const [entry] = entries.splice(i, 1);
            const at = position(op.afterSectionId);
            if (at === undefined) return refuse(`Unknown afterSectionId ${op.afterSectionId}`);
            entries.splice(at, 0, entry!);
            changed.add(entry!.id);
          } else {
            const id = resolve(op.sectionId);
            const old = known.get(id) ?? tx.select().from(lessonSections).where(eq(lessonSections.id, id)).get();
            if (old?.kind !== "prose") return refuse("Only a prose section can be rewritten; remove a card and insert a new one instead.");
            const row = newSection({ kind: "prose", title: op.title ?? old.title, markdown: op.markdown, artifactId: null });
            entries[i] = { ...entries[i]!, id: row.id, title: row.title };
            renamed.set(op.sectionId, row.id);
          }
        }
        if (entries.length === 0) return refuse("A lesson needs at least one section.");
        const version = current.version + 1;
        tx.insert(lessonVersions)
          .values({
            id: randomUUID(),
            lessonId,
            version,
            outline: { title: current.outline.title, sections: entries.map(({ title, kind, purpose }) => ({ title, kind, purpose })) },
            sectionIds: entries.map((e) => e.id),
            changedSectionIds: entries.map((e) => e.id).filter((id) => changed.has(id)),
            reason,
            createdAt: now,
          })
          .run();
        return { ok: true as const, version };
      });
    },

    /** Sections by id, in the order given. */
    sections(ids: string[]): LessonSectionRow[] {
      if (ids.length === 0) return [];
      const rows = new Map(db.select().from(lessonSections).where(inArray(lessonSections.id, ids)).all().map((r) => [r.id, r]));
      return ids.flatMap((id) => rows.get(id) ?? []);
    },

    /** Whether an artifact belongs to a lesson section. Such artifacts can be answered as soon as their section is written. */
    isLessonArtifact(artifactId: string): boolean {
      return Boolean(db.select({ id: lessonSections.id }).from(lessonSections).where(eq(lessonSections.artifactId, artifactId)).get());
    },

    /** The lesson an artifact is a section of, if any. A card the tutor added lives in the course's chat session. */
    lessonForArtifact(artifactId: string): LessonRow | undefined {
      const row = db
        .select({ lesson: lessons })
        .from(lessonSections)
        .innerJoin(lessons, eq(lessons.id, lessonSections.lessonId))
        .where(eq(lessonSections.artifactId, artifactId))
        .get();
      return row?.lesson;
    },

    /** How many of the version's checks exist and how many have an attempt. */
    checkProgress(sectionIds: string[], checkKinds: string[]): { total: number; answered: number } {
      if (sectionIds.length === 0 || checkKinds.length === 0) return { total: 0, answered: 0 };
      const rows = db
        .select({ id: artifacts.id, attempt: attempts.id })
        .from(lessonSections)
        .innerJoin(artifacts, eq(artifacts.id, lessonSections.artifactId))
        .leftJoin(attempts, eq(attempts.artifactId, artifacts.id))
        .where(and(inArray(lessonSections.id, sectionIds), inArray(artifacts.kind, checkKinds)))
        .all();
      return { total: rows.length, answered: rows.filter((r) => r.attempt).length };
    },

    /**
     * Freezes a lesson once the learner reached its end, every section is written and every check
     * answered. Scores don't matter. Returns false if it can't be finished yet.
     */
    finishLesson(id: string, checkKinds: string[]): boolean {
      return db.transaction((tx) => {
        const lesson = tx.select().from(lessons).where(eq(lessons.id, id)).get();
        const version = latestVersion(id);
        if (lesson?.status !== "ready" || !version || version.sectionIds.length < version.outline.sections.length) return false;
        const { total, answered } = this.checkProgress(version.sectionIds, checkKinds);
        if (answered < total) return false;
        tx.update(lessons).set({ status: "finished", finishedAt: clock() }).where(eq(lessons.id, id)).run();
        return true;
      });
    },
  };
}

export type LessonStore = ReturnType<typeof createLessonStore>;
