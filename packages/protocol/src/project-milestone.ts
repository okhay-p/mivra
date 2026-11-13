import { z } from "zod";
import { MAX_CASE_INPUT_CHARS, MAX_CASE_OUTPUT_CHARS, MAX_EXERCISE_CASES, normaliseOutput } from "./code-exercise.js";

/**
 * project_milestone v1: one milestone of a project course (ADR-016), checked in the learner's own repository with
 * `mivra check`. The tutor writes the spec, the exact output format, test inputs and a Python reference. When the
 * milestone is created the server runs the reference on every input in Pyodide, and what it prints becomes the
 * expected output, whatever language the learner builds in. A milestone whose reference fails is rejected.
 *
 * `mivra check` fetches the cases as data (never a command), runs the learner's own command on each and reports
 * what it printed; the server compares that with the expected output after `normaliseOutput`. Step 3 of ADR-016's
 * build order has only `tests` milestones; `review` comes with model review.
 */

export const MILESTONE_CHECK_TYPES = ["tests"] as const;
export const MilestoneCheckType = z.enum(MILESTONE_CHECK_TYPES);
export type MilestoneCheckType = z.infer<typeof MilestoneCheckType>;

/** How a case's result is compared: what the learner's program prints, or what its output prints when run. */
export const MilestoneCompare = z.enum(["stdout", "run_output"]);
export type MilestoneCompare = z.infer<typeof MilestoneCompare>;

/** The Python reference. Longer than an exercise's: it may be a small interpreter for what the learner builds. */
export const MAX_MILESTONE_REFERENCE_CHARS = 20_000;
/** What `mivra check` reports of one case's stderr, for the learner and the tutor to read. */
export const MAX_MILESTONE_STDERR_CHARS = 2_000;

export const MilestoneCaseInput = z
  .object({
    name: z.string().trim().min(1).max(80).describe('A short name the learner sees, e.g. "empty input" or "nested parentheses".'),
    input: z
      .string()
      .max(MAX_CASE_INPUT_CHARS)
      .describe("The case's input. The learner's program gets it on stdin and as a file whose path replaces {input} in their command. Use \"\" for none."),
    compare: MilestoneCompare.optional().describe(
      'stdout (the default) compares what the learner\'s program prints. run_output is for programs whose output is itself a program, such as a compiler\'s generated assembly: Mivra runs that output with the learner\'s own run-output command and compares what it prints, so the reference prints what running it should print.',
    ),
  })
  .strict();
export type MilestoneCaseInput = z.infer<typeof MilestoneCaseInput>;

const milestoneFields = {
  concept: z.string().trim().min(1).max(80).describe('Short label for what this milestone practises, e.g. "tokenizing". Used to track progress.'),
  title: z.string().trim().min(1).max(120),
  spec: z
    .string()
    .trim()
    .min(1)
    .max(6000)
    .describe("What the learner's program must do at this milestone, as markdown: the behaviour to add, building on the earlier milestones."),
  outputFormat: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Exactly what the program prints for an input, as markdown with an example, so any language can match it. Trailing spaces and trailing blank lines are ignored."),
  checkType: MilestoneCheckType.describe("tests: Mivra runs the learner's program on the cases and compares what it prints."),
};

/** The tool's input. Expected outputs aren't part of it: the server computes them from the reference. */
export const ProjectMilestoneInput = z
  .object({
    ...milestoneFields,
    cases: z
      .array(MilestoneCaseInput)
      .min(1)
      .max(MAX_EXERCISE_CASES)
      .describe(`1-${MAX_EXERCISE_CASES} cases, simplest first, covering the milestone's edge cases. Each reference run has a 2 s limit.`),
    referenceSolution: z
      .string()
      .min(1)
      .max(MAX_MILESTONE_REFERENCE_CHARS)
      .describe(
        "A Python program (standard library only) that reads a case's input from stdin and prints exactly what the learner's program should print, or for a run_output case what running its output should print. Mivra runs it in Pyodide on every case to get the expected outputs and never shows it. It must be deterministic.",
      ),
  })
  .strict();
export type ProjectMilestoneInput = z.infer<typeof ProjectMilestoneInput>;

export const MilestoneCase = MilestoneCaseInput.extend({ expected: z.string().max(MAX_CASE_OUTPUT_CHARS) }).strict();
export type MilestoneCase = z.infer<typeof MilestoneCase>;

/** The stored spec: the input with each case's expected output (normalised) from the reference run. */
export const ProjectMilestoneSpec = z
  .object({
    ...milestoneFields,
    cases: z.array(MilestoneCase).min(1).max(MAX_EXERCISE_CASES),
    referenceSolution: z.string().max(MAX_MILESTONE_REFERENCE_CHARS),
  })
  .strict();
export type ProjectMilestoneSpec = z.infer<typeof ProjectMilestoneSpec>;

/** The learner sees every case and its expected output; only the reference stays on the server. */
export const ProjectMilestonePublic = z
  .object({
    concept: z.string(),
    title: z.string(),
    spec: z.string(),
    outputFormat: z.string(),
    checkType: MilestoneCheckType,
    cases: z.array(z.object({ name: z.string(), input: z.string(), compare: MilestoneCompare, expected: z.string() }).strict()),
  })
  .strict();
export type ProjectMilestonePublic = z.infer<typeof ProjectMilestonePublic>;

export const toProjectMilestonePublic = (spec: ProjectMilestoneSpec): ProjectMilestonePublic => ({
  concept: spec.concept,
  title: spec.title,
  spec: spec.spec,
  outputFormat: spec.outputFormat,
  checkType: spec.checkType,
  cases: spec.cases.map((c) => ({ name: c.name, input: c.input, compare: c.compare ?? "stdout", expected: c.expected })),
});

/**
 * The current milestone's cases as `mivra check` fetches them (GET /courses/{id}/milestone): data only. Nothing here
 * is ever run; the only command that runs is the one the learner set with `mivra link`.
 */
export const MilestoneCases = z
  .object({
    courseId: z.string(),
    lessonId: z.string(),
    artifactId: z.string(),
    /** The milestone's place in the syllabus, from 1. */
    position: z.number().int().positive(),
    title: z.string(),
    checkType: MilestoneCheckType,
    cases: z.array(z.object({ name: z.string(), input: z.string().max(MAX_CASE_INPUT_CHARS), compare: MilestoneCompare }).strict()).min(1).max(MAX_EXERCISE_CASES),
  })
  .strict();
export type MilestoneCases = z.infer<typeof MilestoneCases>;

/** Why a case produced no comparable output. */
export const MilestoneRunError = z.enum(["timeout", "output_limit", "start_failed", "no_run_output_command"]);
export type MilestoneRunError = z.infer<typeof MilestoneRunError>;

/** What running one case produced on the learner's machine. `stdout` is normalised, and cut short if `truncated`. */
export const MilestoneCaseResult = z
  .object({
    stdout: z.string().max(MAX_CASE_OUTPUT_CHARS),
    truncated: z.boolean().optional(),
    stderr: z.string().max(MAX_MILESTONE_STDERR_CHARS).optional(),
    /** The exit code, or null if it was killed or never started. */
    exitCode: z.number().int().nullable(),
    error: MilestoneRunError.optional(),
  })
  .strict();
export type MilestoneCaseResult = z.infer<typeof MilestoneCaseResult>;

/** Body of POST /artifacts/{id}/checks: one result per case, in case order. */
export const MilestoneCheckAnswer = z.object({ results: z.array(MilestoneCaseResult).min(1).max(MAX_EXERCISE_CASES) }).strict();
export type MilestoneCheckAnswer = z.infer<typeof MilestoneCheckAnswer>;

export const MilestoneGrade = z
  .object({
    correct: z.boolean(),
    passed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    cases: z.array(z.object({ passed: z.boolean() }).strict()),
  })
  .strict();
export type MilestoneGrade = z.infer<typeof MilestoneGrade>;

/** Whether one case's run matches: it exited with 0, wasn't cut short, and printed the expected output. */
export function milestoneCasePassed(expected: string, run: MilestoneCaseResult): boolean {
  return run.error === undefined && !run.truncated && run.exitCode === 0 && normaliseOutput(run.stdout) === normaliseOutput(expected);
}

/** Deterministic grader (ADR-006). Throws if the answer doesn't report one result per case. */
export function gradeMilestone(spec: ProjectMilestoneSpec, answer: MilestoneCheckAnswer): MilestoneGrade {
  if (answer.results.length !== spec.cases.length) {
    throw new RangeError(`Expected results for ${spec.cases.length} cases, got ${answer.results.length}`);
  }
  const cases = spec.cases.map((c, i) => ({ passed: milestoneCasePassed(c.expected, answer.results[i]!) }));
  const passed = cases.filter((c) => c.passed).length;
  return { correct: passed === cases.length, passed, total: cases.length, cases };
}

/** What POST /artifacts/{id}/checks returns: the grade, and each case's expected output, for `mivra check` to show beside what it got. */
export const MilestoneCheckResult = z
  .object({
    grade: MilestoneGrade,
    expected: z.array(z.string()),
  })
  .strict();
export type MilestoneCheckResult = z.infer<typeof MilestoneCheckResult>;
