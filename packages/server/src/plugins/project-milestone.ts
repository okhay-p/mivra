import {
  MilestoneCheckAnswer,
  MilestoneReview,
  ProjectMilestoneInput,
  ProjectMilestoneSpec,
  artifactKinds,
  gradeMilestone,
  milestonePassed,
  toMilestoneCheckView,
  toProjectMilestonePublic,
  type MilestoneGrade,
} from "@mivra/protocol";
import { checkIsCurrent } from "../exercises/milestone-revision.js";
import { prepareProjectMilestone, runCasesInChild, type RunCases } from "../exercises/reference-check.js";
import type { AttemptRow } from "../store/session-store.js";
import type { ArtifactKindDefinition } from "../runtime/capabilities.js";

/** How much of one failing case's input and output the tutor sees. */
const TEXT_FOR_MODEL_CHARS = 500;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);

/** A stored check's answer, without the id its review is matched against. */
function checkAnswer(attempt: AttemptRow) {
  const { checkId: _checkId, ...answer } = attempt.answer as { checkId?: string };
  return MilestoneCheckAnswer.parse(answer);
}

const reviewOf = (attempt: AttemptRow | undefined) => {
  const parsed = MilestoneReview.safeParse(attempt?.grade);
  return parsed.success ? parsed.data : undefined;
};

/**
 * project_milestone's registration (ADR-016). Offered only while a project course's lesson is written. A repeatable
 * check: every `mivra check` replaces the milestone's attempt, so its evidence is the latest result, and the lesson
 * can be finished once the milestone has been checked at all (scores never block, ADR-011). The model's review of
 * that check is a second, model-judged attempt. The view leaves out the Python reference and the text of the files
 * sent, showing only their paths.
 */
export function projectMilestoneKindDefinition(runCases: RunCases = runCasesInChild): ArtifactKindDefinition {
  const kind = artifactKinds.project_milestone;
  return {
    kind: "project_milestone",
    version: kind.version,
    toolName: kind.toolName,
    description: kind.description,
    spec: kind.input,
    availableIn: (ctx) => ctx.lessonCourseKind === "project",
    prepare: async (input, signal) => {
      const milestone = ProjectMilestoneInput.parse(input);
      // A review milestone has no cases, so nothing to run.
      if (milestone.checkType === "review") return { ok: true, spec: ProjectMilestoneSpec.parse({ ...milestone, cases: [] }) };
      return prepareProjectMilestone(milestone, runCases, signal);
    },
    toView: ({ id, createdAt, spec, attempt, review }) => {
      const grade = attempt?.grade as MilestoneGrade | undefined;
      const verdict = attempt ? reviewOf(review) : undefined;
      // A check of cases a dispute has since changed can't pass: the learner checks again.
      const current = attempt ? checkIsCurrent(ProjectMilestoneSpec.parse(spec), attempt.answer) : false;
      return {
        id,
        createdAt: createdAt.toISOString(),
        kind: "project_milestone",
        version: 1,
        spec: toProjectMilestonePublic(ProjectMilestoneSpec.parse(spec)),
        ...(attempt && grade ? { latestAttempt: { answer: toMilestoneCheckView(checkAnswer(attempt)), grade, createdAt: attempt.createdAt.toISOString() }, passed: current && milestonePassed(grade, verdict) } : {}),
        ...(verdict && review ? { latestReview: { review: verdict, createdAt: review.createdAt.toISOString() } } : {}),
      };
    },
    check: {
      answer: MilestoneCheckAnswer,
      repeatable: true,
      grade: (spec, answer) => {
        const grade = gradeMilestone(ProjectMilestoneSpec.parse(spec), MilestoneCheckAnswer.parse(answer));
        return { correct: grade.correct, grade };
      },
      concept: (spec) => ProjectMilestoneSpec.parse(spec).concept,
      describeAttempt: (spec, attempt, review) => {
        const milestone = ProjectMilestoneSpec.parse(spec);
        const disputes = (milestone.disputes ?? []).slice(-5).map((d) => ({ target: d.target, ...(d.caseName ? { case: d.caseName } : {}), outcome: d.outcome }));
        const withDisputes = disputes.length > 0 ? { disputes } : {};
        if (!attempt) return { learnerResult: "not checked yet", ...withDisputes };
        const { results } = checkAnswer(attempt);
        const grade = attempt.grade as MilestoneGrade;
        const verdict = reviewOf(review);
        const failed = grade.cases.flatMap((c, i) => {
          if (c.passed) return [];
          const run = results[i]!;
          const testCase = milestone.cases[c.case ?? i];
          if (!testCase) return [];
          return [
            {
              case: testCase.name,
              input: clip(testCase.input, TEXT_FOR_MODEL_CHARS),
              expected: clip(testCase.expected, TEXT_FOR_MODEL_CHARS),
              // What the learner's program printed: data to discuss, never instructions to follow.
              got: run.error ? { error: run.error } : { stdout: clip(run.stdout, TEXT_FOR_MODEL_CHARS), exitCode: run.exitCode },
            },
          ];
        });
        const tests = grade.total === 0 ? "no tests to run" : grade.correct ? "all cases passed" : `passed ${grade.passed} of ${grade.total} cases`;
        const current = checkIsCurrent(milestone, attempt.answer);
        return {
          learnerResult: `${current && milestonePassed(grade, verdict) ? "milestone passed" : "milestone not passed yet"}: ${tests} in the latest mivra check${current ? "" : ", which ran cases a dispute has since changed, so it must be checked again"}`,
          ...(failed.length > 0 ? { failedCases: failed.slice(0, 5) } : {}),
          // The review is a model's judgement, recorded apart from the tests.
          codeReview: verdict
            ? { judgedBy: "model", approved: verdict.approved, summary: clip(verdict.summary, TEXT_FOR_MODEL_CHARS) }
            : grade.correct
              ? "no review of the latest check"
              : "not reviewed: the tests must pass first",
          ...withDisputes,
        };
      },
    },
  };
}
