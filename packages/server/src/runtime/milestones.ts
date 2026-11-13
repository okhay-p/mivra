import { MilestoneCheckAnswer, ProjectMilestoneSpec, gradeMilestone, type MilestoneCases, type MilestoneCheckResult } from "@mivra/protocol";
import type { LessonStore } from "../store/lesson-store.js";
import type { SessionStore } from "../store/session-store.js";
import { courseLessons } from "./lessons.js";

/**
 * Project courses (ADR-016): the milestone `mivra check` checks, and recording what it found. Each syllabus topic's
 * lesson ends with one project_milestone section; the current milestone is the one in the first unfinished lesson.
 */

type Deps = { store: SessionStore; lessons: LessonStore };

export type MilestoneError = { kind: "not_found" | "conflict" | "invalid"; message: string };

/** The current milestone's cases, as data for `mivra check`. Never anything to run. */
export function currentMilestone(courseId: string, { store, lessons }: Deps): { ok: true; value: MilestoneCases } | { ok: false; error: MilestoneError } {
  const course = store.findCourse(courseId);
  if (!course) return { ok: false, error: { kind: "not_found", message: "Course not found" } };
  if (course.kind !== "project") return { ok: false, error: { kind: "conflict", message: "This course isn't a project course, so it has no milestones to check." } };
  if (course.status === "interviewing") return { ok: false, error: { kind: "conflict", message: "The course is still in its placement interview. Finish it in Mivra first." } };
  if (course.status === "complete") return { ok: false, error: { kind: "conflict", message: "Every milestone in this course is finished." } };
  const plan = courseLessons(courseId, { store, lessons });
  const lesson = plan.currentLessonId ? lessons.findLesson(plan.currentLessonId) : undefined;
  if (!lesson || lesson.status === "finished") {
    return { ok: false, error: { kind: "conflict", message: "The next milestone hasn't started. Open the course in Mivra to start it." } };
  }
  const found = milestoneOf(lesson.id, { store, lessons });
  if (!found) return { ok: false, error: { kind: "conflict", message: "This milestone is still being written. Try again once it appears in Mivra." } };
  const position = (store.latestSyllabus(courseId)?.topics.findIndex((t) => t.id === lesson.topicId) ?? -1) + 1;
  return {
    ok: true,
    value: {
      courseId,
      lessonId: lesson.id,
      artifactId: found.artifactId,
      position: position > 0 ? position : lesson.position + 1,
      title: found.spec.title,
      checkType: found.spec.checkType,
      cases: found.spec.cases.map((c) => ({ name: c.name, input: c.input, compare: c.compare ?? "stdout" })),
    },
  };
}

/** The milestone in a lesson's latest version: its last project_milestone section. */
function milestoneOf(lessonId: string, { store, lessons }: Deps): { artifactId: string; spec: ProjectMilestoneSpec } | undefined {
  const sectionIds = lessons.latestVersion(lessonId)?.sectionIds ?? [];
  for (const section of lessons.sections(sectionIds).reverse()) {
    const artifact = section.artifactId ? store.findArtifact(section.artifactId) : undefined;
    if (artifact?.kind === "project_milestone") return { artifactId: artifact.id, spec: ProjectMilestoneSpec.parse(artifact.spec) };
  }
  return undefined;
}

/**
 * Grades one `mivra check` deterministically (ADR-006) and records it as the milestone's attempt, replacing the last
 * one, so its evidence is the latest result. Refused once the milestone's lesson is finished: it's frozen (ADR-011).
 */
export function recordMilestoneCheck(
  artifactId: string,
  answer: unknown,
  { store, lessons }: Deps,
): { ok: true; lessonId: string; result: MilestoneCheckResult } | { ok: false; error: MilestoneError } {
  const artifact = store.findArtifact(artifactId);
  if (!artifact || artifact.kind !== "project_milestone") return { ok: false, error: { kind: "not_found", message: "Milestone not found" } };
  const lesson = lessons.lessonForArtifact(artifactId);
  if (!lesson) return { ok: false, error: { kind: "not_found", message: "Milestone not found" } };
  if (lesson.status === "finished") return { ok: false, error: { kind: "conflict", message: "This milestone's lesson is finished, so it can't be checked again." } };
  // Only the milestone in the lesson's current version counts.
  if (milestoneOf(lesson.id, { store, lessons })?.artifactId !== artifactId) {
    return { ok: false, error: { kind: "conflict", message: "This isn't the lesson's current milestone." } };
  }
  const parsed = MilestoneCheckAnswer.safeParse(answer);
  if (!parsed.success) return { ok: false, error: { kind: "invalid", message: "Invalid check results" } };
  const spec = ProjectMilestoneSpec.parse(artifact.spec);
  if (parsed.data.results.length !== spec.cases.length) {
    return { ok: false, error: { kind: "invalid", message: `Expected results for ${spec.cases.length} cases, got ${parsed.data.results.length}. Run mivra check again.` } };
  }
  const grade = gradeMilestone(spec, parsed.data);
  store.replaceAttempt({ artifactId, sessionId: artifact.sessionId, answer: parsed.data, grade, correct: grade.correct, concept: spec.concept });
  return { ok: true, lessonId: lesson.id, result: { grade, expected: spec.cases.map((c) => c.expected) } };
}
