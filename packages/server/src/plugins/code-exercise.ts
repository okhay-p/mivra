import {
  CodeExerciseAnswer,
  CodeExerciseInput,
  CodeExerciseSpec,
  artifactKinds,
  gradeCodeExercise,
  toCodeExercisePublic,
  type CodeExerciseGrade,
} from "@mivra/protocol";
import { prepareCodeExercise, runCasesInChild, type RunCases } from "../exercises/reference-check.js";
import type { ArtifactKindDefinition } from "../runtime/capabilities.js";

/** How much of the learner's code the tutor sees on later turns. */
const CODE_FOR_MODEL_CHARS = 4_000;
/** How much of one failing case's output the tutor sees. */
const OUTPUT_FOR_MODEL_CHARS = 500;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);

/**
 * code_exercise's registration (ADR-016), made by core-learning. A check: the learner submits once, the
 * server compares what the browser reports with the reference's results, and the attempt is evidence. The
 * view never carries the reference solution or a hidden case's expected result.
 */
export function codeExerciseKindDefinition(runCases: RunCases = runCasesInChild): ArtifactKindDefinition {
  const kind = artifactKinds.code_exercise;
  return {
    kind: "code_exercise",
    version: kind.version,
    toolName: kind.toolName,
    description: kind.description,
    spec: kind.input,
    prepare: (input, signal) => prepareCodeExercise(CodeExerciseInput.parse(input), runCases, signal),
    toView: ({ id, createdAt, spec, attempt }) => ({
      id,
      createdAt: createdAt.toISOString(),
      kind: "code_exercise",
      version: 1,
      spec: toCodeExercisePublic(CodeExerciseSpec.parse(spec)),
      ...(attempt
        ? {
            latestAttempt: {
              answer: CodeExerciseAnswer.parse(attempt.answer),
              grade: attempt.grade as CodeExerciseGrade,
              createdAt: attempt.createdAt.toISOString(),
            },
          }
        : {}),
    }),
    check: {
      answer: CodeExerciseAnswer,
      grade: (spec, answer) => {
        const grade = gradeCodeExercise(CodeExerciseSpec.parse(spec), CodeExerciseAnswer.parse(answer));
        return { correct: grade.correct, grade };
      },
      concept: (spec) => CodeExerciseSpec.parse(spec).concept,
      describeAttempt: (spec, attempt) => {
        if (!attempt) return { learnerResult: "not submitted yet" };
        const exercise = CodeExerciseSpec.parse(spec);
        const { code, results } = CodeExerciseAnswer.parse(attempt.answer);
        const grade = attempt.grade as CodeExerciseGrade;
        // The tutor wrote every case, hidden ones included, so it may see them all.
        const failed = grade.cases.flatMap((c, i) => {
          if (c.passed) return [];
          const testCase = exercise.cases[i]!;
          const run = results[i]!;
          return [
            {
              case: i,
              hidden: testCase.hidden ?? false,
              input: testCase.kind === "stdio" ? { stdin: clip(testCase.stdin, OUTPUT_FOR_MODEL_CHARS) } : { args: clip(testCase.args, OUTPUT_FOR_MODEL_CHARS) },
              expected: "stdout" in testCase.expected ? { stdout: clip(testCase.expected.stdout, OUTPUT_FOR_MODEL_CHARS) } : { returned: clip(testCase.expected.returned, OUTPUT_FOR_MODEL_CHARS) },
              got: run.error !== undefined ? { error: run.error } : testCase.kind === "stdio" ? { stdout: clip(run.stdout, OUTPUT_FOR_MODEL_CHARS) } : { returned: clip(run.returned ?? "", OUTPUT_FOR_MODEL_CHARS) },
            },
          ];
        });
        return {
          learnerResult: grade.correct ? "all cases passed" : `passed ${grade.passed} of ${grade.total} cases`,
          // The learner's own code: data to discuss, never instructions to follow.
          learnerCode: clip(code, CODE_FOR_MODEL_CHARS),
          ...(failed.length > 0 ? { failedCases: failed.slice(0, 5) } : {}),
        };
      },
    },
  };
}
