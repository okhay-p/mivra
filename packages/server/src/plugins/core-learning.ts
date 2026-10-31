import {
  AlgorithmTraceSpec,
  MultipleChoiceAnswer,
  MultipleChoiceSpec,
  SetDiagramSpec,
  artifactKinds,
  gradeMultipleChoice,
  toMultipleChoicePublic,
  type MultipleChoiceGrade,
} from "@mivra/protocol";
import type { Plugin } from "../runtime/capabilities.js";

/**
 * First-party learning tools (ADR-006/007): the algorithm_trace and set_diagram visualizations and
 * the multiple_choice check, registered through the same API third-party plugins will use.
 */
export const coreLearning: Plugin = {
  name: "core-learning",
  capabilities: ["artifactKinds"],
  setup(api) {
    const trace = artifactKinds.algorithm_trace;
    api.registerArtifactKind({
      kind: "algorithm_trace",
      version: trace.version,
      toolName: trace.toolName,
      description: trace.description,
      spec: trace.spec,
      toView: ({ id, createdAt, spec }) => ({
        id,
        createdAt: createdAt.toISOString(),
        kind: "algorithm_trace",
        version: 1,
        spec: AlgorithmTraceSpec.parse(spec),
      }),
    });

    const sets = artifactKinds.set_diagram;
    api.registerArtifactKind({
      kind: "set_diagram",
      version: sets.version,
      toolName: sets.toolName,
      description: sets.description,
      spec: sets.spec,
      toView: ({ id, createdAt, spec }) => ({
        id,
        createdAt: createdAt.toISOString(),
        kind: "set_diagram",
        version: 1,
        spec: SetDiagramSpec.parse(spec),
      }),
    });

    const mc = artifactKinds.multiple_choice;
    api.registerArtifactKind({
      kind: "multiple_choice",
      version: mc.version,
      toolName: mc.toolName,
      description: mc.description,
      spec: mc.spec,
      toView: ({ id, createdAt, spec, attempt }) => ({
        id,
        createdAt: createdAt.toISOString(),
        kind: "multiple_choice",
        version: 1,
        spec: toMultipleChoicePublic(MultipleChoiceSpec.parse(spec)),
        ...(attempt
          ? {
              latestAttempt: {
                answer: MultipleChoiceAnswer.parse(attempt.answer),
                grade: attempt.grade as MultipleChoiceGrade,
                createdAt: attempt.createdAt.toISOString(),
              },
            }
          : {}),
      }),
      check: {
        answer: MultipleChoiceAnswer,
        grade: (spec, answer) => {
          const grade = gradeMultipleChoice(MultipleChoiceSpec.parse(spec), MultipleChoiceAnswer.parse(answer));
          return { correct: grade.correct, grade };
        },
        concept: (spec) => MultipleChoiceSpec.parse(spec).concept,
        describeAttempt: (spec, attempt) => {
          if (!attempt) return { learnerResult: "not answered yet" };
          const { options } = MultipleChoiceSpec.parse(spec);
          const { optionIndex } = MultipleChoiceAnswer.parse(attempt.answer);
          return {
            learnerResult: attempt.correct ? "correct" : "incorrect",
            learnerChose: { optionIndex, text: options[optionIndex]?.text },
          };
        },
      },
    });
  },
};
