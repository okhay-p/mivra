import { z } from "zod";
import { AlgorithmTraceSpec } from "./algorithm-trace.js";
import { MultipleChoiceAnswer, MultipleChoiceGrade, MultipleChoicePublic, MultipleChoiceSpec } from "./multiple-choice.js";
import { SetDiagramSpec } from "./set-diagram.js";

export * from "./algorithm-trace.js";
export * from "./multiple-choice.js";
export * from "./set-diagram.js";

/**
 * Every artifact kind the agent can produce, one tool per kind (ADR-006). The tool's input schema is
 * the kind's spec schema, so the model is told exactly what to send and the server validates it.
 * Bump `version` and keep the old schema when a spec changes incompatibly; stored artifacts record
 * the version they were created with.
 */
export const artifactKinds = {
  algorithm_trace: {
    version: 1,
    toolName: "show_algorithm_trace",
    description:
      "Show the learner an interactive step-by-step trace of an algorithm running over a sequence (e.g. sliding window, two pointers, binary search, a simple sort). The learner steps through it with play/pause/step controls. Use it when watching state change step by step will make the idea click. Keep traces short (roughly 5-20 steps) and make each step's explanation say what changed and why.",
    spec: AlgorithmTraceSpec,
  },
  multiple_choice: {
    version: 1,
    toolName: "ask_multiple_choice",
    description:
      "Ask the learner one multiple-choice question to check understanding of a concept you just taught. Exactly one option is correct. Write plausible wrong options that reflect real misconceptions, and give per-option feedback where useful. The learner answers in the UI; the result is reported back to you on the next turn, so do not reveal the answer in your reply.",
    spec: MultipleChoiceSpec,
  },
  set_diagram: {
    version: 1,
    toolName: "show_set_diagram",
    description:
      "Show the learner a Venn diagram of 1 to 3 sets, with what each region contains. Use it for set operations (union, intersection, complement, difference) and inclusion-exclusion, not for more than 3 sets. Keep elements short, because they are drawn in their region. Add steps to walk through it: each step highlights exact regions (any of them, including outside every set, which needs `universe`) and says what changed and why.",
    spec: SetDiagramSpec,
  },
} as const;

export type ArtifactKind = keyof typeof artifactKinds;
export const ArtifactKind = z.enum(Object.keys(artifactKinds) as [ArtifactKind, ...ArtifactKind[]]);

/** Finds the kind registered for a tool name, if any. */
export function kindForTool(toolName: string): ArtifactKind | undefined {
  return (Object.keys(artifactKinds) as ArtifactKind[]).find((kind) => artifactKinds[kind].toolName === toolName);
}

const ArtifactBase = { id: z.string(), createdAt: z.string().datetime() };

export const MultipleChoiceAttempt = z
  .object({ answer: MultipleChoiceAnswer, grade: MultipleChoiceGrade, createdAt: z.string().datetime() })
  .strict();
export type MultipleChoiceAttempt = z.infer<typeof MultipleChoiceAttempt>;

/**
 * An artifact as the client receives it. Checks expose only their public view until answered;
 * after an attempt, the grade (with the correct answer and explanation) is included.
 */
export const ArtifactView = z.discriminatedUnion("kind", [
  z
    .object({ ...ArtifactBase, kind: z.literal("algorithm_trace"), version: z.literal(1), spec: AlgorithmTraceSpec })
    .strict(),
  z
    .object({
      ...ArtifactBase,
      kind: z.literal("multiple_choice"),
      version: z.literal(1),
      spec: MultipleChoicePublic,
      latestAttempt: MultipleChoiceAttempt.optional(),
    })
    .strict(),
  z.object({ ...ArtifactBase, kind: z.literal("set_diagram"), version: z.literal(1), spec: SetDiagramSpec }).strict(),
]);
export type ArtifactView = z.infer<typeof ArtifactView>;

export * from "./memory.js";
