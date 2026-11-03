import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { artifacts, attempts, lessonSections, lessonVersions, lessons, sessions } from "../db/schema.js";

export type LessonRow = typeof lessons.$inferSelect;
export type LessonSectionRow = typeof lessonSections.$inferSelect;
export type LessonOutline = { title: string; sections: { title: string; kind: string; purpose: string }[] };
export type LessonVersionRow = Omit<typeof lessonVersions.$inferSelect, "outline" | "sectionIds"> & { outline: LessonOutline; sectionIds: string[] };

/**
 * Persistence for lessons (ADR-011). Like SessionStore, the only code that touches these tables.
 * Sections are immutable; a version is an outline plus an ordered list of section ids.
 */
export function createLessonStore(db: Db, clock: () => Date = () => new Date()) {
  const latestVersion = (lessonId: string): LessonVersionRow | undefined => {
    const row = db.select().from(lessonVersions).where(eq(lessonVersions.lessonId, lessonId)).orderBy(desc(lessonVersions.version)).get();
    return row && { ...row, outline: row.outline as LessonOutline, sectionIds: row.sectionIds as string[] };
  };

  return {
    latestVersion,

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
