import { z } from "zod";

/**
 * code_exercise v1: a single-file coding exercise the learner edits and runs in the browser (ADR-016). The
 * tutor writes the instructions, starter code, test cases and a reference solution. When the exercise is
 * created the server runs the reference against every case, and the expected results come from that run,
 * never from text the model typed; an exercise whose reference fails is rejected. The reference solution
 * and the hidden cases' expected results stay on the server. The browser runs the learner's code on every
 * case and reports what it produced; the server compares that with the expected results (grading is
 * deterministic, ADR-006, though the outputs come from the browser and aren't tamper-proof, ADR-016).
 *
 * The schema takes a language so Python (#120) fits; v1 accepts only JavaScript.
 */

export const EXERCISE_LANGUAGES = ["javascript"] as const;
export const ExerciseLanguage = z.enum(EXERCISE_LANGUAGES);
export type ExerciseLanguage = z.infer<typeof ExerciseLanguage>;

export const MAX_EXERCISE_CASES = 20;
/** Starter code and the reference solution. */
export const MAX_EXERCISE_CODE_CHARS = 10_000;
/** The learner's code as submitted: room to grow past the starter. */
export const MAX_SUBMITTED_CODE_CHARS = 50_000;
export const MAX_CASE_INPUT_CHARS = 10_000;
/** One case's captured output (stdout and stderr together) and its return value's JSON, each. */
export const MAX_CASE_OUTPUT_CHARS = 20_000;
export const MAX_CASE_ERROR_CHARS = 2_000;

/**
 * The limits one case runs under, in the browser and on the server alike: QuickJS's interrupt handler stops
 * it after `timeMs`, its WebAssembly memory can't grow past `memoryBytes` (QuickJS's own baseline included),
 * and its stack is capped below the JavaScript engine's own, so deep recursion fails cleanly.
 */
export const EXERCISE_LIMITS = {
  timeMs: 2_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 384 * 1024,
  outputChars: MAX_CASE_OUTPUT_CHARS,
} as const;
export type ExerciseLimits = { timeMs: number; memoryBytes: number; stackBytes: number; outputChars: number };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const hidden = z
  .boolean()
  .optional()
  .describe("Hidden from the learner's view until they submit: use for edge cases. At least one case must be visible.");

export const ExerciseStdioCaseInput = z
  .object({
    kind: z.literal("stdio"),
    stdin: z
      .string()
      .max(MAX_CASE_INPUT_CHARS)
      .describe('The text the program reads, through the global `stdin` string or `readLine()`. Use "" for none.'),
    hidden,
  })
  .strict();

export const ExerciseCallCaseInput = z
  .object({
    kind: z.literal("call"),
    args: z
      .string()
      .max(MAX_CASE_INPUT_CHARS)
      .describe('The arguments to call functionName with, as a JSON array, e.g. "[[3, 1, 2], 2]" or "[]".'),
    hidden,
  })
  .strict();

export const ExerciseCaseInput = z.discriminatedUnion("kind", [ExerciseStdioCaseInput, ExerciseCallCaseInput]);
export type ExerciseCaseInput = z.infer<typeof ExerciseCaseInput>;

/** What the reference produced for a case: printed output for stdio, the return value's JSON for a call. */
export const ExerciseExpected = z.union([
  z.object({ stdout: z.string().max(MAX_CASE_OUTPUT_CHARS) }).strict(),
  z.object({ returned: z.string().max(MAX_CASE_OUTPUT_CHARS) }).strict(),
]);
export type ExerciseExpected = z.infer<typeof ExerciseExpected>;

const exerciseFields = {
  concept: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('Short label for the concept being practised, e.g. "array reduce". Used to track progress.'),
  title: z.string().trim().min(1).max(120),
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("What the learner's code must do, as markdown. Say exactly what to print or return, and for stdio how the input is laid out."),
  language: ExerciseLanguage,
  starterCode: z
    .string()
    .max(MAX_EXERCISE_CODE_CHARS)
    .describe("The code the editor starts with, e.g. the function's signature with an empty body. May be empty."),
  functionName: z
    .string()
    .regex(IDENTIFIER)
    .max(80)
    .optional()
    .describe("The function call cases call, declared at the top level of the learner's code. Required when there are call cases."),
};

function checkCases(spec: { functionName?: string; cases: ExerciseCaseInput[] }, ctx: z.RefinementCtx) {
  if (spec.cases.every((c) => c.hidden)) ctx.addIssue({ code: "custom", path: ["cases"], message: "at least one case must be visible" });
  const calls = spec.cases.some((c) => c.kind === "call");
  if (calls && !spec.functionName) ctx.addIssue({ code: "custom", path: ["functionName"], message: "functionName is required for call cases" });
  spec.cases.forEach((c, i) => {
    if (c.kind !== "call") return;
    let args: unknown;
    try {
      args = JSON.parse(c.args);
    } catch {
      return ctx.addIssue({ code: "custom", path: ["cases", i, "args"], message: "args must be a JSON array" });
    }
    if (!Array.isArray(args)) ctx.addIssue({ code: "custom", path: ["cases", i, "args"], message: "args must be a JSON array" });
  });
}

/** The tool's input: what the model writes. Expected results aren't part of it; the server computes them. */
export const CodeExerciseInput = z
  .object({
    ...exerciseFields,
    cases: z.array(ExerciseCaseInput).min(1).max(MAX_EXERCISE_CASES).describe("1-20 test cases. Keep each fast: every case has a 2 s limit."),
    referenceSolution: z
      .string()
      .min(1)
      .max(MAX_EXERCISE_CODE_CHARS)
      .describe("A complete correct solution. Mivra runs it on every case to get the expected results; it is never shown to the learner. It must be deterministic (no Math.random or Date)."),
  })
  .strict()
  .superRefine(checkCases);
export type CodeExerciseInput = z.infer<typeof CodeExerciseInput>;

export const ExerciseCase = z.discriminatedUnion("kind", [
  ExerciseStdioCaseInput.extend({ expected: ExerciseExpected }),
  ExerciseCallCaseInput.extend({ expected: ExerciseExpected }),
]);
export type ExerciseCase = z.infer<typeof ExerciseCase>;

/** The stored spec: the input with each case's expected result from the reference run. */
export const CodeExerciseSpec = z
  .object({
    ...exerciseFields,
    cases: z.array(ExerciseCase).min(1).max(MAX_EXERCISE_CASES),
    referenceSolution: z.string().max(MAX_EXERCISE_CODE_CHARS),
  })
  .strict();
export type CodeExerciseSpec = z.infer<typeof CodeExerciseSpec>;

/** A case as the client sees it: hidden cases carry their input (the browser runs them) but not their expected result. */
export const ExercisePublicCase = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stdio"), stdin: z.string(), hidden: z.boolean(), expected: ExerciseExpected.optional() }).strict(),
  z.object({ kind: z.literal("call"), args: z.string(), hidden: z.boolean(), expected: ExerciseExpected.optional() }).strict(),
]);
export type ExercisePublicCase = z.infer<typeof ExercisePublicCase>;

export const CodeExercisePublic = z
  .object({
    concept: z.string(),
    title: z.string(),
    instructions: z.string(),
    language: ExerciseLanguage,
    starterCode: z.string(),
    functionName: z.string().optional(),
    cases: z.array(ExercisePublicCase),
  })
  .strict();
export type CodeExercisePublic = z.infer<typeof CodeExercisePublic>;

export function toCodeExercisePublic(spec: CodeExerciseSpec): CodeExercisePublic {
  return {
    concept: spec.concept,
    title: spec.title,
    instructions: spec.instructions,
    language: spec.language,
    starterCode: spec.starterCode,
    ...(spec.functionName ? { functionName: spec.functionName } : {}),
    cases: spec.cases.map((c) => {
      const isHidden = c.hidden ?? false;
      const input = c.kind === "stdio" ? { kind: "stdio" as const, stdin: c.stdin } : { kind: "call" as const, args: c.args };
      return { ...input, hidden: isHidden, ...(isHidden ? {} : { expected: c.expected }) };
    }),
  };
}

/** What running one case produced. `returned` is the return value's JSON (or "undefined"), for call cases only. */
export const ExerciseCaseRun = z
  .object({
    stdout: z.string().max(MAX_CASE_OUTPUT_CHARS),
    stderr: z.string().max(MAX_CASE_OUTPUT_CHARS).optional(),
    returned: z.string().max(MAX_CASE_OUTPUT_CHARS).optional(),
    error: z.string().max(MAX_CASE_ERROR_CHARS).optional(),
  })
  .strict();
export type ExerciseCaseRun = z.infer<typeof ExerciseCaseRun>;

/** A submission: the learner's code and what it produced on every case, in case order. */
export const CodeExerciseAnswer = z
  .object({
    code: z.string().max(MAX_SUBMITTED_CODE_CHARS),
    results: z.array(ExerciseCaseRun).min(1).max(MAX_EXERCISE_CASES),
  })
  .strict();
export type CodeExerciseAnswer = z.infer<typeof CodeExerciseAnswer>;

export const CodeExerciseGrade = z
  .object({
    correct: z.boolean(),
    passed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    cases: z.array(z.object({ passed: z.boolean() }).strict()),
  })
  .strict();
export type CodeExerciseGrade = z.infer<typeof CodeExerciseGrade>;

/**
 * Printed output as it's compared: line endings as \n, trailing whitespace dropped from each line and trailing
 * blank lines dropped. Leading whitespace and blank lines between lines count.
 */
export function normaliseOutput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Whether two return values' JSON texts are the same value. Object key order doesn't matter; "undefined" matches only itself. */
export function sameReturnValue(a: string, b: string): boolean {
  if (a === "undefined" || b === "undefined") return a === b;
  try {
    return JSON.stringify(canonical(JSON.parse(a))) === JSON.stringify(canonical(JSON.parse(b)));
  } catch {
    return false;
  }
}

/** Whether a run produced a case's expected result. A run that threw or hit a limit never passes. */
export function casePassed(expected: ExerciseExpected, run: ExerciseCaseRun): boolean {
  if (run.error !== undefined) return false;
  if ("stdout" in expected) return normaliseOutput(run.stdout) === normaliseOutput(expected.stdout);
  return run.returned !== undefined && sameReturnValue(run.returned, expected.returned);
}

/** The expected result recorded from a reference run. Throws if the run failed. */
export function expectedFrom(testCase: ExerciseCaseInput, run: ExerciseCaseRun): ExerciseExpected {
  if (run.error !== undefined) throw new Error(run.error);
  if (testCase.kind === "stdio") return { stdout: normaliseOutput(run.stdout) };
  if (run.returned === undefined) throw new Error("The function returned nothing Mivra could record");
  return { returned: run.returned };
}

/** Deterministic grader. Throws if the answer doesn't report one result per case. */
export function gradeCodeExercise(spec: CodeExerciseSpec, answer: CodeExerciseAnswer): CodeExerciseGrade {
  if (answer.results.length !== spec.cases.length) {
    throw new RangeError(`Expected results for ${spec.cases.length} cases, got ${answer.results.length}`);
  }
  const cases = spec.cases.map((c, i) => ({ passed: casePassed(c.expected, answer.results[i]!) }));
  const passed = cases.filter((c) => c.passed).length;
  return { correct: passed === cases.length, passed, total: cases.length, cases };
}
