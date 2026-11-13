import { createHash, randomUUID } from "node:crypto";
import {
  CommitId,
  MilestoneCheckAnswer,
  MilestoneDisputeRequest,
  MilestoneReview,
  ProjectMilestoneInput,
  ProjectMilestoneSpec,
  activeMilestoneCases,
  gradeMilestone,
  milestonePassed,
  MAX_MILESTONE_DISPUTES,
  type ArtifactView,
  type MilestoneCases,
  type MilestoneCheckResult,
  type MilestoneDispute,
  type MilestoneGrade,
  type MilestoneReviewStatus,
} from "@mivra/protocol";
import type { LessonStore } from "../store/lesson-store.js";
import type { AttemptRow, SessionStore } from "../store/session-store.js";
import { artifactView } from "./artifacts.js";
import type { CapabilityRegistry } from "./capabilities.js";
import { publicErrorText } from "./errors.js";
import { courseLessons } from "./lessons.js";
import { disputeRecord, type MilestoneReviewer } from "./milestone-review.js";

/**
 * Project courses (ADR-016): the milestone `mivra check` checks, recording what it found, the model's review of the
 * code, and disputes. Each syllabus topic's lesson ends with one project_milestone section; the current milestone is
 * the one in the first unfinished lesson.
 *
 * A check is two pieces of evidence (ADR-009): the grader's attempt, from the tests, and the model's, from the review,
 * recorded only when every case passed. The milestone passes when both are correct; the review can never turn a
 * failed test into a pass, since it doesn't run unless every test passed.
 */

type Deps = { store: SessionStore; lessons: LessonStore };

export type MilestoneError = { kind: "not_found" | "conflict" | "invalid" | "failed"; message: string };

/** A check as stored in the grader's attempt: what `mivra check` sent, and an id its review is matched against. */
type StoredCheck = { checkId?: string; answer: MilestoneCheckAnswer };

function readCheck(attempt: AttemptRow | undefined): StoredCheck | undefined {
  if (!attempt) return undefined;
  const { checkId, ...answer } = attempt.answer as { checkId?: string };
  const parsed = MilestoneCheckAnswer.safeParse(answer);
  return parsed.success ? { checkId, answer: parsed.data } : undefined;
}

/** The latest check's review verdict, if it's for the latest check. */
export function readReview(attempt: AttemptRow | undefined): MilestoneReview | undefined {
  const parsed = MilestoneReview.safeParse(attempt?.grade);
  return parsed.success ? parsed.data : undefined;
}

/** Names the cases a check runs: a check sent for other cases (a dispute changed them meanwhile) is refused. */
export function milestoneRevision(spec: ProjectMilestoneSpec): string {
  const active = activeMilestoneCases(spec).map((c) => [c.index, c.name, c.input, c.compare ?? "stdout", c.expected]);
  return createHash("sha256").update(JSON.stringify([spec.checkType, active])).digest("hex").slice(0, 16);
}

/** Whether a milestone's latest check passed: every case, and the review's approval. */
export function milestoneCheckPassed(artifactId: string, store: SessionStore): boolean {
  const check = store.findAttempt(artifactId);
  return Boolean(check && milestonePassed(check.grade as MilestoneGrade, readReview(store.findReview(artifactId))));
}

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
  // The changes since the last passed milestone are what's reviewed: the commit that milestone's check ran at.
  let since: string | null = null;
  for (const topic of plan.topics) {
    if (!topic.lesson || topic.lesson.id === lesson.id) break;
    const earlier = milestoneOf(topic.lesson.id, { store, lessons });
    if (!earlier || !milestoneCheckPassed(earlier.artifactId, store)) continue;
    const commit = CommitId.safeParse(readCheck(store.findAttempt(earlier.artifactId))?.answer.commit);
    if (commit.success) since = commit.data;
  }
  return {
    ok: true,
    value: {
      courseId,
      lessonId: lesson.id,
      artifactId: found.artifactId,
      position: position > 0 ? position : lesson.position + 1,
      title: found.spec.title,
      checkType: found.spec.checkType,
      revision: milestoneRevision(found.spec),
      since,
      cases: activeMilestoneCases(found.spec).map((c) => ({ name: c.name, input: c.input, compare: c.compare ?? "stdout" })),
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

/** The milestone behind an id, if it's the current one of an unfinished lesson: the only one that can change. */
function openMilestone(artifactId: string, { store, lessons }: Deps, frozen: string) {
  const artifact = store.findArtifact(artifactId);
  if (!artifact || artifact.kind !== "project_milestone") return { ok: false as const, error: { kind: "not_found" as const, message: "Milestone not found" } };
  const lesson = lessons.lessonForArtifact(artifactId);
  if (!lesson) return { ok: false as const, error: { kind: "not_found" as const, message: "Milestone not found" } };
  if (lesson.status === "finished") return { ok: false as const, error: { kind: "conflict" as const, message: frozen } };
  // Only the milestone in the lesson's current version counts.
  if (milestoneOf(lesson.id, { store, lessons })?.artifactId !== artifactId) {
    return { ok: false as const, error: { kind: "conflict" as const, message: "This isn't the lesson's current milestone." } };
  }
  return { ok: true as const, artifact, lesson, spec: ProjectMilestoneSpec.parse(artifact.spec) };
}

/** Whether a stored check is still the one with this id, in a lesson that isn't finished: a review may be saved for it. */
const stillCurrent = (checkId: string, lessonId: string, lessons: LessonStore) => (check: AttemptRow | undefined) =>
  readCheck(check)?.checkId === checkId && lessons.findLesson(lessonId)?.status !== "finished";

/**
 * Grades one `mivra check` deterministically (ADR-006) and records it as the milestone's attempt, replacing the last
 * one, so its evidence is the latest result. Then, if every case passed and files were sent, the model reviews them
 * and its verdict is recorded as a separate, model-judged attempt. Refused once the milestone's lesson is finished:
 * it's frozen (ADR-011). `onRecorded` runs once the tests' result is saved, before the review.
 */
export async function recordMilestoneCheck(
  artifactId: string,
  answer: unknown,
  { store, lessons, reviewer, onRecorded, signal }: Deps & { reviewer: MilestoneReviewer; onRecorded?: (lessonId: string) => void; signal?: AbortSignal },
): Promise<{ ok: true; lessonId: string; result: MilestoneCheckResult } | { ok: false; error: MilestoneError }> {
  const open = openMilestone(artifactId, { store, lessons }, "This milestone's lesson is finished, so it can't be checked again.");
  if (!open.ok) return open;
  const { artifact, lesson, spec } = open;
  const parsed = MilestoneCheckAnswer.safeParse(answer);
  if (!parsed.success) return { ok: false, error: { kind: "invalid", message: "Invalid check results" } };
  if (parsed.data.revision !== undefined && parsed.data.revision !== milestoneRevision(spec)) {
    return { ok: false, error: { kind: "conflict", message: "The milestone's cases changed while this check ran (a dispute was decided). Run mivra check again." } };
  }
  const active = activeMilestoneCases(spec);
  if (parsed.data.results.length !== active.length) {
    return { ok: false, error: { kind: "invalid", message: `Expected results for ${active.length} cases, got ${parsed.data.results.length}. Run mivra check again.` } };
  }
  const grade = gradeMilestone(spec, parsed.data);
  const checkId = randomUUID();
  // With no cases to run (a review milestone, or every case withdrawn) the tests say nothing, so they give no evidence.
  store.replaceAttempt({ artifactId, sessionId: artifact.sessionId, answer: { ...parsed.data, checkId }, grade, correct: grade.correct, concept: active.length > 0 ? spec.concept : null });
  onRecorded?.(lesson.id);

  const files = parsed.data.files ?? [];
  let review: MilestoneReviewStatus;
  if (!grade.correct) review = { status: "skipped", reason: "tests_failed" };
  else if (files.length === 0) review = { status: "skipped", reason: "no_files" };
  else {
    try {
      const verdict = await reviewer.review({ spec, files, deleted: parsed.data.deleted, skipped: parsed.data.skipped }, signal);
      const saved = store.saveReview(
        { artifactId, sessionId: artifact.sessionId, answer: { checkId }, grade: verdict, correct: verdict.approved, concept: spec.concept },
        stillCurrent(checkId, lesson.id, lessons),
      );
      review = saved ? { status: "done", review: verdict } : { status: "failed", error: "A newer check, or finishing the lesson, replaced this one while it was reviewed." };
    } catch (error) {
      review = { status: "failed", error: publicErrorText(error) };
    }
  }
  return {
    ok: true,
    lessonId: lesson.id,
    result: {
      grade,
      expected: active.map((c) => c.expected),
      review,
      passed: milestonePassed(grade, review.status === "done" ? review.review : undefined),
    },
  };
}

/** Milestones with a dispute being decided: one at a time each, so two can't both rewrite its cases. */
const deciding = new Set<string>();

/**
 * A learner's dispute of a case or of the latest review verdict (ADR-016). The tutor looks again: a case may be kept,
 * withdrawn or corrected (a corrected reference is rerun on every case before anything is saved), and a verdict
 * upheld or overturned by a fresh review that weighs the learner's argument. The dispute and its outcome are kept on
 * the milestone. A changed case counts from the next `mivra check`; an overturned verdict replaces the review at once,
 * though the milestone still passes only if every test did.
 */
export async function disputeMilestone(
  artifactId: string,
  body: unknown,
  { store, lessons, registry, reviewer, signal }: Deps & { registry: CapabilityRegistry; reviewer: MilestoneReviewer; signal?: AbortSignal },
): Promise<{ ok: true; lessonId: string; view: ArtifactView; dispute: MilestoneDispute } | { ok: false; error: MilestoneError }> {
  const request = MilestoneDisputeRequest.safeParse(body);
  if (!request.success) return { ok: false, error: { kind: "invalid", message: "Invalid dispute" } };
  const open = openMilestone(artifactId, { store, lessons }, "This milestone's lesson is finished, so it can't be disputed.");
  if (!open.ok) return open;
  const { artifact, lesson, spec } = open;
  if ((spec.disputes?.length ?? 0) >= MAX_MILESTONE_DISPUTES) {
    return { ok: false, error: { kind: "conflict", message: `A milestone can have at most ${MAX_MILESTONE_DISPUTES} disputes. Ask the tutor in the chat instead.` } };
  }
  if (deciding.has(artifactId)) return { ok: false, error: { kind: "conflict", message: "The tutor is still deciding another dispute about this milestone." } };
  deciding.add(artifactId);
  try {
    let record: MilestoneDispute;
    let next: ProjectMilestoneSpec;
    if (request.data.target === "case") {
      const { caseIndex, reason } = request.data;
      const testCase = spec.cases[caseIndex];
      if (!testCase || testCase.withdrawn) return { ok: false, error: { kind: "invalid", message: "There's no such case to dispute." } };
      const check = readCheck(store.findAttempt(artifactId));
      const grade = store.findAttempt(artifactId)?.grade as MilestoneGrade | undefined;
      const at = grade?.cases.findIndex((c, i) => (c.case ?? i) === caseIndex) ?? -1;
      const result = at >= 0 ? check?.answer.results[at] : undefined;
      const prepare = registry.artifactKind("project_milestone")?.prepare;
      const { decision, corrected } = await reviewer.resolveCase<ProjectMilestoneSpec>(
        {
          spec,
          caseIndex,
          reason,
          result,
          // A correction is checked as a new milestone is: the reference runs on every case still in use.
          correct: async (decision) => {
            if (!prepare) return { ok: false, message: "Mivra can't rerun the reference here." };
            const cases = spec.cases.map((c, i) => (i === caseIndex && decision.input !== undefined ? { ...c, input: decision.input } : c));
            const kept = cases.flatMap((c, index) => (c.withdrawn ? [] : [{ c, index }]));
            const input = ProjectMilestoneInput.safeParse({
              concept: spec.concept,
              title: spec.title,
              spec: spec.spec,
              outputFormat: spec.outputFormat,
              checkType: "tests",
              ...(spec.reviewFocus ? { reviewFocus: spec.reviewFocus } : {}),
              cases: kept.map(({ c }) => ({ name: c.name, input: c.input, ...(c.compare ? { compare: c.compare } : {}) })),
              referenceSolution: decision.referenceSolution ?? spec.referenceSolution,
            });
            if (!input.success) return { ok: false, message: `The correction isn't valid: ${input.error.issues[0]?.message ?? "invalid"}` };
            const prepared = await prepare(input.data, signal);
            if (!prepared.ok) return { ok: false, message: prepared.reason.replace("call set_project_milestone again", "call resolve_case_dispute again") };
            const rerun = ProjectMilestoneSpec.parse(prepared.spec);
            const byIndex = new Map(kept.map(({ index }, i) => [index, rerun.cases[i]!]));
            return {
              ok: true,
              value: { ...spec, referenceSolution: rerun.referenceSolution, cases: cases.map((c, i) => (byIndex.has(i) ? { ...byIndex.get(i)!, ...(c.withdrawn ? { withdrawn: true } : {}) } : c)) },
            };
          },
        },
        signal,
      );
      const outcome = decision.outcome === "keep" ? "kept" : decision.outcome === "withdraw" ? "withdrawn" : "corrected";
      next =
        outcome === "withdrawn"
          ? { ...spec, cases: spec.cases.map((c, i) => (i === caseIndex ? { ...c, withdrawn: true } : c)) }
          : outcome === "corrected" && corrected
            ? corrected
            : spec;
      record = disputeRecord({
        target: "case",
        caseIndex,
        caseName: testCase.name,
        reason,
        outcome,
        explanation: decision.explanation,
        ...(outcome === "corrected" ? { before: { input: testCase.input, expected: testCase.expected } } : {}),
      });
    } else {
      const { reason } = request.data;
      const checkAttempt = store.findAttempt(artifactId);
      const check = readCheck(checkAttempt);
      const previous = readReview(store.findReview(artifactId));
      if (!check?.checkId || !previous) return { ok: false, error: { kind: "conflict", message: "There's no review of the latest check to dispute." } };
      if (previous.approved) return { ok: false, error: { kind: "conflict", message: "The review approved this check, so there's nothing to dispute." } };
      const verdict = await reviewer.review(
        { spec, files: check.answer.files ?? [], deleted: check.answer.deleted, skipped: check.answer.skipped, dispute: { reason, previous } },
        signal,
      );
      const saved = store.saveReview(
        { artifactId, sessionId: artifact.sessionId, answer: { checkId: check.checkId }, grade: verdict, correct: verdict.approved, concept: spec.concept },
        stillCurrent(check.checkId, lesson.id, lessons),
      );
      if (!saved) return { ok: false, error: { kind: "conflict", message: "A newer check replaced the one you disputed. Look at its review first." } };
      next = spec;
      record = disputeRecord({ target: "review", reason, outcome: verdict.approved ? "overturned" : "upheld", explanation: verdict.summary });
    }
    // The milestone may have been frozen while the tutor decided.
    if (lessons.findLesson(lesson.id)?.status === "finished") {
      return { ok: false, error: { kind: "conflict", message: "This milestone's lesson was finished meanwhile, so the dispute wasn't recorded." } };
    }
    store.updateArtifactSpec(artifactId, ProjectMilestoneSpec.parse({ ...next, disputes: [...(spec.disputes ?? []), record] }));
    return { ok: true, lessonId: lesson.id, view: artifactView(artifactId, registry, store)!, dispute: record };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: { kind: "failed", message: "The dispute was stopped." } };
    return { ok: false, error: { kind: "failed", message: publicErrorText(error) } };
  } finally {
    deciding.delete(artifactId);
  }
}
