import {
  MilestoneCheckAnswer,
  ProjectMilestoneInput,
  ProjectMilestoneSpec,
  artifactKinds,
  gradeMilestone,
  toProjectMilestonePublic,
  type MilestoneGrade,
} from "@mivra/protocol";
import { prepareProjectMilestone, runCasesInChild, type RunCases } from "../exercises/reference-check.js";
import type { ArtifactKindDefinition } from "../runtime/capabilities.js";

/** How much of one failing case's input and output the tutor sees. */
const TEXT_FOR_MODEL_CHARS = 500;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);

/**
 * project_milestone's registration (ADR-016). Offered only while a project course's lesson is written. A repeatable
 * check: every `mivra check` replaces the milestone's attempt, so its evidence is the latest result, and the lesson
 * can be finished once the milestone has been checked at all (scores never block, ADR-011). The view leaves out the
 * Python reference.
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
    prepare: (input, signal) => prepareProjectMilestone(ProjectMilestoneInput.parse(input), runCases, signal),
    toView: ({ id, createdAt, spec, attempt }) => ({
      id,
      createdAt: createdAt.toISOString(),
      kind: "project_milestone",
      version: 1,
      spec: toProjectMilestonePublic(ProjectMilestoneSpec.parse(spec)),
      ...(attempt
        ? { latestAttempt: { answer: MilestoneCheckAnswer.parse(attempt.answer), grade: attempt.grade as MilestoneGrade, createdAt: attempt.createdAt.toISOString() } }
        : {}),
    }),
    check: {
      answer: MilestoneCheckAnswer,
      repeatable: true,
      grade: (spec, answer) => {
        const grade = gradeMilestone(ProjectMilestoneSpec.parse(spec), MilestoneCheckAnswer.parse(answer));
        return { correct: grade.correct, grade };
      },
      concept: (spec) => ProjectMilestoneSpec.parse(spec).concept,
      describeAttempt: (spec, attempt) => {
        if (!attempt) return { learnerResult: "not checked yet" };
        const milestone = ProjectMilestoneSpec.parse(spec);
        const { results } = MilestoneCheckAnswer.parse(attempt.answer);
        const grade = attempt.grade as MilestoneGrade;
        const failed = grade.cases.flatMap((c, i) => {
          if (c.passed) return [];
          const run = results[i]!;
          const testCase = milestone.cases[i]!;
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
        return {
          learnerResult: grade.correct ? "all cases passed in the latest mivra check" : `passed ${grade.passed} of ${grade.total} cases in the latest mivra check`,
          ...(failed.length > 0 ? { failedCases: failed.slice(0, 5) } : {}),
        };
      },
    },
  };
}
