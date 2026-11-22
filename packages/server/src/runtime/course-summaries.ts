import type { LessonStore } from "../store/lesson-store.js";
import type { CourseRow, SessionStore } from "../store/session-store.js";

/**
 * What a course amounts to so far, for the memory panel and the tutor (issue #135). Derived each time from the
 * course, its latest syllabus and its lessons, never stored as a memory, so facts stay apart from guesses (ADR-009)
 * and deleting the course removes it everywhere.
 */
export interface CourseSummary {
  id: string;
  sessionId: string;
  title: string;
  icon: string | null;
  kind: CourseRow["kind"];
  status: CourseRow["status"];
  /** The latest syllabus's topics in order, each with whether its lesson is finished. */
  topics: { title: string; finished: boolean }[];
  /** When the course was completed: its last lesson's finish. Undefined unless complete. */
  completedAt?: Date;
}

/** The learner's courses, most recently started first. */
export function courseSummaries(store: SessionStore, lessons: LessonStore): CourseSummary[] {
  return store.listCourses().map((course) => {
    const courseLessons = lessons.listLessons(course.id);
    const finished = new Set(courseLessons.filter((l) => l.status === "finished").map((l) => l.topicId));
    const topics = (store.latestSyllabus(course.id)?.topics ?? []).map((t) => ({ title: t.title, finished: finished.has(t.id) }));
    const lastFinish = courseLessons.reduce<Date | undefined>((latest, l) => (l.finishedAt && (!latest || l.finishedAt > latest) ? l.finishedAt : latest), undefined);
    return {
      id: course.id,
      sessionId: course.sessionId,
      title: course.title,
      icon: course.icon,
      kind: course.kind,
      status: course.status,
      topics,
      ...(course.status === "complete" ? { completedAt: lastFinish ?? course.updatedAt } : {}),
    };
  });
}
