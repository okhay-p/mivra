import { z } from "zod";
import { artifactMathInput, checkMathText } from "./artifact-math-input.js";
import { AlgorithmTraceSpec } from "./algorithm-trace.js";
import { CodeExerciseAnswer, CodeExerciseGrade, CodeExerciseInput, CodeExercisePublic, CodeExerciseSpec } from "./code-exercise.js";
import { CodeWalkthroughSpec } from "./code-walkthrough.js";
import { CompositionArtifactView, compositionArtifactKind } from "./composition.js";
import {
  InterviewContextAnswer,
  InterviewContextGrade,
  InterviewContextSpec,
  PlacementAnswer,
  PlacementGrade,
  PlacementQuestionPublic,
  PlacementQuestionSpec,
} from "./course.js";
import { GraphSpec } from "./graph.js";
import { MultipleChoiceAnswer, MultipleChoiceGrade, MultipleChoicePublic, MultipleChoiceSpec } from "./multiple-choice.js";
import { SetDiagramSpec } from "./set-diagram.js";
import { TableSpec } from "./table.js";
import { WorkedStepsSpec } from "./worked-steps.js";

export * from "./artifact-math-input.js";
export * from "./math-text.js";
export * from "./algorithm-trace.js";
export * from "./code-exercise.js";
export * from "./code-exercise-runner.js";
export * from "./code-exercise-python.js";
export * from "./code-walkthrough.js";
export * from "./composition.js";
export * from "./course.js";
export * from "./lesson.js";
export * from "./graph.js";
export * from "./multiple-choice.js";
export * from "./set-diagram.js";
export * from "./table.js";
export * from "./worked-steps.js";

/**
 * Every artifact kind the agent can produce, one tool per kind (ADR-006).
 * `input` adds current authoring checks to the stored `spec` schema, so old artifacts stay readable.
 * Bump `version` and keep the old schema when a spec changes incompatibly; stored artifacts record
 * the version they were created with.
 */
export const artifactKinds = {
  algorithm_trace: {
    version: 1,
    toolName: "show_algorithm_trace",
    description:
      "Show the learner an interactive step-by-step trace of an algorithm running over a sequence (e.g. sliding window, two pointers, binary search, a simple sort). The learner steps through it with play/pause/step controls. Use it when watching state change step by step will make the idea click. Keep traces short (roughly 5-20 steps) and make each step's explanation say what changed and why. A code pane is optional: add `code` and each step's `lines` only when the code itself is the point, such as how an implementation's lines move the state, and leave it out when the idea matters more than any code. Write that code in the programming language the learner has shown proficiency in according to <learner_memories>; if they show none, use Python or pseudocode. Keep the code short, and highlight the lines each step is running. For code that doesn't move over a sequence, such as a plain function or a React render, use show_code_walkthrough instead of inventing an array.",
    spec: AlgorithmTraceSpec,
    input: artifactMathInput(AlgorithmTraceSpec, ["title", "steps.*.explanation"]),
  },
  code_exercise: {
    version: 1,
    toolName: "ask_code_exercise",
    description:
      "Give the learner a short JavaScript or Python coding exercise to solve in an editor in the UI, after teaching an idea they can now practise by writing code. Use the language they are learning. They run the visible cases as often as they like, then submit once; their result is reported back to you on the next turn, so don't reveal or hint at a solution in your reply. Keep it to one small function or program (a few to about 30 lines), with 3-8 fast cases. Two kinds of case: a call case calls `functionName` (defined at the top level) with JSON arguments and compares its return value as JSON (key order ignored; in Python, None is null and tuples are lists), and a stdio case runs the whole program with the case's stdin and compares what it prints (trailing whitespace and trailing blank lines ignored). Prefer call cases; use stdio for programs that read input and print. JavaScript runs as plain JavaScript with no DOM, network, modules, timers or Node APIs: only console, the global `stdin` string and `readLine()` (the next input line, or null). Python runs in Pyodide with the standard library only: no network, files, threads, subprocesses or packages to install; read input with input() or sys.stdin and print with print(). Write a correct, deterministic referenceSolution in the same language: Mivra runs it on every case to get the expected results, rejecting the exercise if it fails, and never shows it. Hide a case or two that check edge cases. The starter code should give the function's signature (or the program's outline) and no solution.",
    spec: CodeExerciseSpec,
    input: artifactMathInput(CodeExerciseInput, ["title"]),
  },
  code_walkthrough: {
    version: 1,
    toolName: "show_code_walkthrough",
    description:
      "Show the learner a step-by-step walkthrough of a short piece of code that isn't about a sequence: a plain function's parameters, locals and return value, or a React component's renders, handlers and state updates. Each step highlights the source lines it is at and gives a complete snapshot of the visible state (`variables`) and the visible output (`output`, plain text such as printed lines or what the page shows, e.g. \"Count: 0\"); nothing carries over between steps, so repeat whatever still applies and use [] or \"\" for none. The source stays the same on every step. Use show_algorithm_trace instead for an algorithm moving over an array or other sequence, and show_graph for a component hierarchy. Keep the code short (a few to about 20 lines) and the walkthrough short (roughly 3-12 steps). Write the code in the language the concept belongs to (JSX for React); for a language-neutral idea, use the language the learner knows from <learner_memories>, else Python or pseudocode. The snapshots are your illustration, not a real run, so get them right. For React, keep the state a render or handler sees apart from updates it queues: inside a handler, state still has the value from the render it belongs to (name it, e.g. \"handler.count\" = 0, with \"queued update\" = \"count + 1\"), and the new value and its output appear only at the next render's step.",
    spec: CodeWalkthroughSpec,
    input: artifactMathInput(CodeWalkthroughSpec, ["title", "steps.*.explanation"]),
  },
  composition: compositionArtifactKind,
  graph: {
    version: 1,
    toolName: "show_graph",
    description:
      "Show the learner a graph or tree, drawn for you, optionally with steps they can walk through. Use it for graphs, trees, BFS, DFS, shortest paths, spanning trees and tree traversals, whenever seeing the structure or watching an algorithm move over it will help. Never give coordinates: the layout is automatic. For a binary search tree or binary tree traversal, set kind to tree and give every edge a side, so a lone left child and a lone right child are drawn differently. The automatic layout may draw crossing edges that mean nothing, even when the graph is planar, so don't use this to show whether a graph is planar. Keep it small enough to read (roughly 4-15 nodes, 5-20 steps) and make each step's explanation say what changed and why. For a component hierarchy (such as React components), set kind to tree and directed to true, with one node per component instance (distinct ids for two instances of the same component, labelled with the short component name) and one edge from each parent to each child it renders, labelled with the props it passes (e.g. \"count\" or \"onClick\"). Use steps to highlight where state is owned and the nodes and edges its value flows through, with variables for simple state such as count = 1. The nodes and edges stay the same on every step: don't add callback edges back up the tree, and don't suggest that a component's output changes just because it re-renders. To show where things are and how they move between containers, such as names sharing one object, values passing through pipeline stages or tasks moving between a queue and a stack, use show_composition instead.",
    spec: GraphSpec,
    input: artifactMathInput(GraphSpec, ["title", "nodes.*.label", "edges.*.label", "steps.*.explanation"], (spec, ctx) => {
      spec.nodes.forEach((node, i) => {
        if (node.label === undefined) checkMathText(node.id, ["nodes", i, "id"], ctx);
      });
    }),
  },
  interview_context: {
    version: 1,
    toolName: "ask_interview_context",
    description:
      "Course placement interview only: ask the learner once, as the last question of the interview and in the same reply as the placement questions, whether there is anything else they want you to know about what they already understand or want to explore. They answer in their own words in the UI, or leave it blank; the answer is reported back to you with the placement results. Not graded.",
    spec: InterviewContextSpec,
    input: artifactMathInput(InterviewContextSpec, ["question"]),
  },
  multiple_choice: {
    version: 1,
    toolName: "ask_multiple_choice",
    description:
      "Ask the learner one multiple-choice question to check understanding of a concept you just taught. Exactly one option is correct. Write plausible wrong options that reflect real misconceptions, and give per-option feedback where useful. The learner answers in the UI; the result is reported back to you on the next turn, so do not reveal the answer in your reply. For a code prediction, put the short snippet in a fenced code block in your reply text before this call and ask what it returns, prints or displays; the question and options render maths and plain text only, so never put code fences in them.",
    spec: MultipleChoiceSpec,
    input: artifactMathInput(MultipleChoiceSpec, ["question", "options.*.text", "options.*.feedback", "explanation"]),
  },
  placement_question: {
    version: 1,
    toolName: "ask_placement_question",
    description:
      "Course placement interview only: ask the learner one quick question to find out what they already know about one concept, before the syllabus is written. Use multiple choice, true/false or yes/no. The UI always adds \"Not sure\" and \"Skip\", so never include those as options. The learner answers in the UI and the result is reported back to you, so don't reveal the answer.",
    spec: PlacementQuestionSpec,
    input: artifactMathInput(PlacementQuestionSpec, ["question", "options.*.text", "explanation"]),
  },
  set_diagram: {
    version: 1,
    toolName: "show_set_diagram",
    description:
      "Show the learner a Venn diagram of 1 to 3 sets, with what each region contains. Use it for set operations (union, intersection, complement, difference) and inclusion-exclusion, not for more than 3 sets. Keep elements short, because they are drawn in their region. Add steps to walk through it: each step highlights exact regions (any of them, including outside every set, which needs `universe`) and says what changed and why.",
    spec: SetDiagramSpec,
    input: artifactMathInput(SetDiagramSpec, ["title", "universe", "sets.*.label", "regions.*.elements.*", "steps.*.explanation", "steps.*.variables.*.name", "steps.*.variables.*.value"]),
  },
  table: {
    version: 1,
    toolName: "show_table",
    description:
      "Show the learner a table: a truth table, a relation matrix or other tabular working. Use it whenever the content is really rows and columns. Add steps when filling it in or highlighting it one part at a time will help, such as working out a truth table column by column; leave them out for a table to read at a glance. Keep steps short and make each explanation say what changed and why.",
    spec: TableSpec,
    input: artifactMathInput(TableSpec, ["title", "columns.*", "rowHeaders.*", "rows.*.*", "steps.*.explanation", "steps.*.cells.*.value"]),
  },
  worked_steps: {
    version: 1,
    toolName: "show_worked_steps",
    description:
      "Show the learner a proof, an induction or combinatorics working as a sequence of steps they reveal one at a time, each a statement with its justification. Use it when the reasoning is the point and each line follows from the ones before. Use show_algorithm_trace instead for an algorithm's state changing over a sequence.",
    spec: WorkedStepsSpec,
    input: artifactMathInput(WorkedStepsSpec, ["title", "goal", "steps.*.label", "steps.*.statement", "steps.*.justification"]),
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

export const CodeExerciseAttempt = z
  .object({ answer: CodeExerciseAnswer, grade: CodeExerciseGrade, createdAt: z.string().datetime() })
  .strict();
export type CodeExerciseAttempt = z.infer<typeof CodeExerciseAttempt>;

export const InterviewContextAttempt = z
  .object({ answer: InterviewContextAnswer, grade: InterviewContextGrade, createdAt: z.string().datetime() })
  .strict();
export type InterviewContextAttempt = z.infer<typeof InterviewContextAttempt>;

export const PlacementAttempt = z.object({ answer: PlacementAnswer, grade: PlacementGrade, createdAt: z.string().datetime() }).strict();
export type PlacementAttempt = z.infer<typeof PlacementAttempt>;

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
      kind: z.literal("code_exercise"),
      version: z.literal(1),
      spec: CodeExercisePublic,
      latestAttempt: CodeExerciseAttempt.optional(),
    })
    .strict(),
  z
    .object({ ...ArtifactBase, kind: z.literal("code_walkthrough"), version: z.literal(1), spec: CodeWalkthroughSpec })
    .strict(),
  CompositionArtifactView,
  z.object({ ...ArtifactBase, kind: z.literal("graph"), version: z.literal(1), spec: GraphSpec }).strict(),
  z
    .object({
      ...ArtifactBase,
      kind: z.literal("interview_context"),
      version: z.literal(1),
      spec: InterviewContextSpec,
      latestAttempt: InterviewContextAttempt.optional(),
    })
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
  z
    .object({
      ...ArtifactBase,
      kind: z.literal("placement_question"),
      version: z.literal(1),
      spec: PlacementQuestionPublic,
      latestAttempt: PlacementAttempt.optional(),
    })
    .strict(),
  z.object({ ...ArtifactBase, kind: z.literal("set_diagram"), version: z.literal(1), spec: SetDiagramSpec }).strict(),
  z.object({ ...ArtifactBase, kind: z.literal("table"), version: z.literal(1), spec: TableSpec }).strict(),
  z.object({ ...ArtifactBase, kind: z.literal("worked_steps"), version: z.literal(1), spec: WorkedStepsSpec }).strict(),
]);
export type ArtifactView = z.infer<typeof ArtifactView>;

export * from "./memory.js";
export * from "./document.js";
export * from "./vault.js";
export * from "./knowledge.js";

/** ChatGPT's page for the learner's plan usage and per-app limits (ADR-015). */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/**
 * The reply error when the learner's ChatGPT plan has hit a usage limit. The UI recognises it and offers
 * "Manage usage", as OpenAI's guidelines ask (ADR-015).
 */
export const CHATGPT_USAGE_LIMIT_ERROR = "ChatGPT usage limit reached. Review your plan or this app's limit in ChatGPT settings.";
