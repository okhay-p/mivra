import { z } from "zod";
import { MAX_CASE_INPUT_CHARS, MAX_CASE_OUTPUT_CHARS, MAX_EXERCISE_CASES, normaliseOutput } from "./code-exercise.js";

/**
 * project_milestone v1: one milestone of a project course (ADR-016), checked in the learner's own repository with
 * `mivra check`. The tutor writes the spec, the exact output format, test inputs and a Python reference. When the
 * milestone is created the server runs the reference on every input in Pyodide, and what it prints becomes the
 * expected output, whatever language the learner builds in. A milestone whose reference fails is rejected.
 *
 * `mivra check` fetches the cases as data (never a command), runs the learner's own command on each and reports
 * what it printed; the server compares that with the expected output after `normaliseOutput`. It also sends the
 * files changed since the last passed milestone, which a model reviews (ADR-016 step 4): passing needs every test and
 * the review's approval. A `review` milestone has no cases and passes on the review alone.
 */

export const MILESTONE_CHECK_TYPES = ["tests", "review"] as const;
export const MilestoneCheckType = z.enum(MILESTONE_CHECK_TYPES);
export type MilestoneCheckType = z.infer<typeof MilestoneCheckType>;

/** How a case's result is compared: what the learner's program prints, or what its output prints when run. */
export const MilestoneCompare = z.enum(["stdout", "run_output"]);
export type MilestoneCompare = z.infer<typeof MilestoneCompare>;

/** The Python reference. Longer than an exercise's: it may be a small interpreter for what the learner builds. */
export const MAX_MILESTONE_REFERENCE_CHARS = 20_000;
/** What `mivra check` reports of one case's stderr, for the learner and the tutor to read. */
export const MAX_MILESTONE_STDERR_CHARS = 2_000;

/** What `mivra check` sends for review (ADR-016): at most this many files, each this long, and this much in all. */
export const MAX_REVIEW_FILES = 200;
export const MAX_REVIEW_FILE_CHARS = 60_000;
export const MAX_REVIEW_TOTAL_CHARS = 240_000;
export const MAX_REVIEW_PATH_CHARS = 500;

/** A git commit id (SHA-1 or SHA-256), lower-case hex: never anything git could read as an option. */
export const CommitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

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
  checkType: MilestoneCheckType.describe(
    "tests: Mivra runs the learner's program on the cases and compares what it prints, and a code review must approve too. review: no cases or reference; the code review alone decides, for what output can't show (structure, a language feature, concurrency, performance).",
  ),
  reviewFocus: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "What the code review must see in the learner's code for this milestone's concept, e.g. \"the scanner walks the characters itself rather than splitting with a regex\". Required for a review milestone; optional for tests.",
    ),
};

/** The rules between fields that a JSON schema can't say: a tests milestone has cases and a reference, a review one neither. */
function milestoneRules(value: { checkType: MilestoneCheckType; cases?: unknown[]; referenceSolution?: string; reviewFocus?: string }, ctx: z.RefinementCtx) {
  if (value.checkType === "tests") {
    if (!value.cases || value.cases.length === 0) ctx.addIssue({ code: "custom", path: ["cases"], message: "A tests milestone needs at least one case." });
    if (!value.referenceSolution) ctx.addIssue({ code: "custom", path: ["referenceSolution"], message: "A tests milestone needs a referenceSolution." });
  } else {
    if (value.cases && value.cases.length > 0) ctx.addIssue({ code: "custom", path: ["cases"], message: "A review milestone has no cases: the code review decides. Leave cases out." });
    if (value.referenceSolution) ctx.addIssue({ code: "custom", path: ["referenceSolution"], message: "A review milestone has no reference. Leave referenceSolution out." });
    if (!value.reviewFocus) ctx.addIssue({ code: "custom", path: ["reviewFocus"], message: "A review milestone needs reviewFocus: what the review must see in the code." });
  }
}

/** The tool's input. Expected outputs aren't part of it: the server computes them from the reference. */
export const ProjectMilestoneInput = z
  .object({
    ...milestoneFields,
    cases: z
      .array(MilestoneCaseInput)
      .max(MAX_EXERCISE_CASES)
      .optional()
      .describe(`tests only: 1-${MAX_EXERCISE_CASES} cases, simplest first, covering the milestone's edge cases. Each reference run has a 2 s limit. Leave out for review.`),
    referenceSolution: z
      .string()
      .min(1)
      .max(MAX_MILESTONE_REFERENCE_CHARS)
      .optional()
      .describe(
        "tests only: a Python program (standard library only) that reads a case's input from stdin and prints exactly what the learner's program should print, or for a run_output case what running its output should print. Mivra runs it in Pyodide on every case to get the expected outputs and never shows it. It must be deterministic. Leave out for review.",
      ),
  })
  .strict()
  .superRefine(milestoneRules);
export type ProjectMilestoneInput = z.infer<typeof ProjectMilestoneInput>;

export const MilestoneCase = MilestoneCaseInput.extend({
  expected: z.string().max(MAX_CASE_OUTPUT_CHARS),
  /** Withdrawn by the tutor after a dispute: kept for the record, never run or graded again. */
  withdrawn: z.boolean().optional(),
}).strict();
export type MilestoneCase = z.infer<typeof MilestoneCase>;

/** Most disputes one milestone keeps; each costs a model call. */
export const MAX_MILESTONE_DISPUTES = 20;
export const MAX_DISPUTE_REASON_CHARS = 2000;

/** What the tutor decided about a dispute. A case is kept, withdrawn or corrected; a review verdict is upheld or overturned. */
export const MilestoneDisputeOutcome = z.enum(["kept", "withdrawn", "corrected", "upheld", "overturned"]);
export type MilestoneDisputeOutcome = z.infer<typeof MilestoneDisputeOutcome>;

/** A learner's dispute of a case or a review verdict, and what the tutor decided (ADR-016). Kept on the milestone. */
export const MilestoneDispute = z
  .object({
    id: z.string(),
    target: z.enum(["case", "review"]),
    /** The disputed case's index in `cases`, and its name then. */
    caseIndex: z.number().int().nonnegative().optional(),
    caseName: z.string().optional(),
    reason: z.string().max(MAX_DISPUTE_REASON_CHARS),
    outcome: MilestoneDisputeOutcome,
    /** The tutor's explanation, for the learner. */
    explanation: z.string().max(2000),
    /** A corrected case as it was before. */
    before: z.object({ input: z.string(), expected: z.string() }).strict().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MilestoneDispute = z.infer<typeof MilestoneDispute>;

/** The stored spec: the input with each case's expected output (normalised) from the reference run, and its disputes. */
export const ProjectMilestoneSpec = z
  .object({
    ...milestoneFields,
    cases: z.array(MilestoneCase).max(MAX_EXERCISE_CASES),
    referenceSolution: z.string().max(MAX_MILESTONE_REFERENCE_CHARS).optional(),
    disputes: z.array(MilestoneDispute).max(MAX_MILESTONE_DISPUTES).optional(),
  })
  .strict();
export type ProjectMilestoneSpec = z.infer<typeof ProjectMilestoneSpec>;

/** The cases `mivra check` runs and the grader counts, with their place in `cases`: every one not withdrawn. */
export const activeMilestoneCases = (spec: Pick<ProjectMilestoneSpec, "cases">) =>
  spec.cases.flatMap((testCase, index) => (testCase.withdrawn ? [] : [{ ...testCase, index }]));

/** The learner sees every case and its expected output; only the reference stays on the server. */
export const ProjectMilestonePublic = z
  .object({
    concept: z.string(),
    title: z.string(),
    spec: z.string(),
    outputFormat: z.string(),
    checkType: MilestoneCheckType,
    reviewFocus: z.string().optional(),
    cases: z.array(z.object({ name: z.string(), input: z.string(), compare: MilestoneCompare, expected: z.string(), withdrawn: z.boolean().optional() }).strict()),
    disputes: z.array(MilestoneDispute),
  })
  .strict();
export type ProjectMilestonePublic = z.infer<typeof ProjectMilestonePublic>;

export const toProjectMilestonePublic = (spec: ProjectMilestoneSpec): ProjectMilestonePublic => ({
  concept: spec.concept,
  title: spec.title,
  spec: spec.spec,
  outputFormat: spec.outputFormat,
  checkType: spec.checkType,
  ...(spec.reviewFocus ? { reviewFocus: spec.reviewFocus } : {}),
  cases: spec.cases.map((c) => ({ name: c.name, input: c.input, compare: c.compare ?? "stdout", expected: c.expected, ...(c.withdrawn ? { withdrawn: true } : {}) })),
  disputes: spec.disputes ?? [],
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
    /** Names this set of cases; a check reports it back, so results for cases a dispute changed meanwhile are refused. */
    revision: z.string().regex(/^[0-9a-f]{8,64}$/),
    /**
     * The commit the last passed milestone was checked at, if any: `mivra check` sends only what changed since. Only a
     * commit id, which `mivra check` hands to git as data.
     */
    since: CommitId.nullable(),
    /** The cases to run; withdrawn ones are left out. A review milestone has none. */
    cases: z.array(z.object({ name: z.string(), input: z.string().max(MAX_CASE_INPUT_CHARS), compare: MilestoneCompare }).strict()).max(MAX_EXERCISE_CASES),
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

/** One file `mivra check` sends for review: its path from the folder holding `.mivra.json`, and its text. */
export const ReviewFile = z.object({ path: z.string().min(1).max(MAX_REVIEW_PATH_CHARS), content: z.string().max(MAX_REVIEW_FILE_CHARS) }).strict();
export type ReviewFile = z.infer<typeof ReviewFile>;

/**
 * Why a changed file wasn't sent. Only reasons that say nothing about a secret are ever sent to the server: a
 * secret-looking file is left out without its name, and ignored files aren't changes at all.
 */
export const ReviewSkipReason = z.enum(["binary", "too_large", "size_cap", "lockfile"]);
export type ReviewSkipReason = z.infer<typeof ReviewSkipReason>;

/** What a check sends besides the results, for the review: the changed files, what was left out and the commit. */
const reviewFields = {
  /** The commit checked out when the check ran (the files may have changed since), if the repository has one. */
  commit: CommitId.optional(),
  /** Where the files came from: git, or nowhere outside a git repository (nothing is sent then). */
  source: z.enum(["git", "none"]).optional(),
  files: z.array(ReviewFile).max(MAX_REVIEW_FILES).optional(),
  /** Paths of changed files that weren't sent, and why. */
  skipped: z.array(z.object({ path: z.string().max(MAX_REVIEW_PATH_CHARS), reason: ReviewSkipReason }).strict()).max(1000).optional(),
  /** Paths deleted since the last passed milestone. */
  deleted: z.array(z.string().max(MAX_REVIEW_PATH_CHARS)).max(1000).optional(),
};

/** Body of POST /artifacts/{id}/checks: one result per case `GET …/milestone` sent, in its order, and the changed files. */
export const MilestoneCheckAnswer = z
  .object({
    results: z.array(MilestoneCaseResult).max(MAX_EXERCISE_CASES),
    /** The `revision` of the cases that ran. Left out by a `mivra check` from before disputes. */
    revision: z.string().max(64).optional(),
    ...reviewFields,
  })
  .strict()
  .superRefine((answer, ctx) => {
    const total = (answer.files ?? []).reduce((sum, file) => sum + file.content.length, 0);
    if (total > MAX_REVIEW_TOTAL_CHARS) ctx.addIssue({ code: "custom", path: ["files"], message: `At most ${MAX_REVIEW_TOTAL_CHARS} characters of files can be sent.` });
  });
export type MilestoneCheckAnswer = z.infer<typeof MilestoneCheckAnswer>;

export const MilestoneGrade = z
  .object({
    /** Every case that ran passed (true when there were none to run). Not the milestone's pass: that needs the review too. */
    correct: z.boolean(),
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** One per case that ran, with its index in the spec's `cases` (missing in grades from before disputes: then in order). */
    cases: z.array(z.object({ passed: z.boolean(), case: z.number().int().nonnegative().optional() }).strict()),
  })
  .strict();
export type MilestoneGrade = z.infer<typeof MilestoneGrade>;

/** Whether one case's run matches: it exited with 0, wasn't cut short, and printed the expected output. */
export function milestoneCasePassed(expected: string, run: MilestoneCaseResult): boolean {
  return run.error === undefined && !run.truncated && run.exitCode === 0 && normaliseOutput(run.stdout) === normaliseOutput(expected);
}

/**
 * Deterministic grader (ADR-006) over the cases not withdrawn, which the answer reports in order. Throws if it doesn't
 * report one result for each.
 */
export function gradeMilestone(spec: ProjectMilestoneSpec, answer: Pick<MilestoneCheckAnswer, "results">): MilestoneGrade {
  const active = activeMilestoneCases(spec);
  if (answer.results.length !== active.length) {
    throw new RangeError(`Expected results for ${active.length} cases, got ${answer.results.length}`);
  }
  const cases = active.map((c, i) => ({ passed: milestoneCasePassed(c.expected, answer.results[i]!), case: c.index }));
  const passed = cases.filter((c) => c.passed).length;
  return { correct: passed === cases.length, passed, total: cases.length, cases };
}

/** One part of the review's rubric: whether the code meets it, and why, for the learner. */
const ReviewCriterion = z
  .object({
    passed: z.boolean(),
    note: z.string().trim().min(1).max(1000).describe("One to three sentences for the learner, pointing at the file and the code you mean."),
  })
  .strict();

/**
 * The review's rubric (ADR-016), as the model records it through its tool. The server derives the verdict: it approves
 * only if every criterion passed.
 */
export const MilestoneReviewInput = z
  .object({
    noHardCodedOutputs: ReviewCriterion.describe(
      "passed is false if the program special-cases test inputs or prints canned answers instead of computing them, e.g. matching an input string and printing its expected output.",
    ),
    concept: ReviewCriterion.describe("passed is true if the code really does what this milestone teaches (its concept and reviewFocus), not just something that produces the same output."),
    quality: ReviewCriterion.describe(
      "passed is false only for serious problems for a learner at this stage: code that can't be followed, copy-pasted blocks instead of a loop or function, or obvious bugs the tests miss. Style preferences never fail it.",
    ),
    summary: z.string().trim().min(1).max(1500).describe("What you'd tell the learner: what's good, and what to change if anything."),
    suggestions: z.array(z.string().trim().min(1).max(500)).max(8).describe("Optional next steps, most useful first. Never write the solution."),
  })
  .strict();
export type MilestoneReviewInput = z.infer<typeof MilestoneReviewInput>;

/** A review's verdict, recorded as its own evidence, separate from the tests' and marked as judged by a model (ADR-016). */
export const MilestoneReview = MilestoneReviewInput.extend({
  approved: z.boolean(),
  judgedBy: z.literal("model"),
  /** The model that reviewed, as shown in the picker. */
  model: z.string(),
}).strict();
export type MilestoneReview = z.infer<typeof MilestoneReview>;

/** The verdict a rubric gives: approval only when every criterion passed. */
export const reviewVerdict = (input: MilestoneReviewInput, model: string): MilestoneReview => ({
  ...input,
  approved: input.noHardCodedOutputs.passed && input.concept.passed && input.quality.passed,
  judgedBy: "model",
  model,
});

/**
 * What happened to a check's review: its verdict, or why there wasn't one. A review runs only once every case passed,
 * since it can never turn a failed test into a pass, and only when files were sent.
 */
export const MilestoneReviewStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), review: MilestoneReview }).strict(),
  z.object({ status: z.literal("skipped"), reason: z.enum(["tests_failed", "no_files"]) }).strict(),
  z.object({ status: z.literal("failed"), error: z.string() }).strict(),
]);
export type MilestoneReviewStatus = z.infer<typeof MilestoneReviewStatus>;

/** Whether a check passes the milestone: every case that ran passed, and the review approved. */
export const milestonePassed = (grade: Pick<MilestoneGrade, "correct">, review: Pick<MilestoneReview, "approved"> | undefined) => grade.correct && review?.approved === true;

/**
 * What POST /artifacts/{id}/checks returns: the grade, each case's expected output for `mivra check` to show beside
 * what it got, the review, and whether the milestone passed.
 */
export const MilestoneCheckResult = z
  .object({
    grade: MilestoneGrade,
    expected: z.array(z.string()),
    review: MilestoneReviewStatus,
    passed: z.boolean(),
  })
  .strict();
export type MilestoneCheckResult = z.infer<typeof MilestoneCheckResult>;

/** Body of POST /artifacts/{id}/disputes: the learner disputes one case (by its index in `cases`) or the latest review. */
export const MilestoneDisputeRequest = z.discriminatedUnion("target", [
  z.object({ target: z.literal("case"), caseIndex: z.number().int().nonnegative().max(MAX_EXERCISE_CASES - 1), reason: z.string().trim().min(1).max(MAX_DISPUTE_REASON_CHARS) }).strict(),
  z.object({ target: z.literal("review"), reason: z.string().trim().min(1).max(MAX_DISPUTE_REASON_CHARS) }).strict(),
]);
export type MilestoneDisputeRequest = z.infer<typeof MilestoneDisputeRequest>;

/** The tutor's decision about a disputed case, through its tool. */
export const CaseDisputeDecision = z
  .object({
    outcome: z.enum(["keep", "withdraw", "correct"]).describe("keep: the case is right. withdraw: it's wrong or unfair and can't simply be fixed. correct: fix its input or the reference."),
    explanation: z.string().trim().min(1).max(2000).describe("For the learner: why, in two or three sentences."),
    input: z.string().max(MAX_CASE_INPUT_CHARS).optional().describe("correct only: the case's corrected input, if the input was wrong."),
    referenceSolution: z
      .string()
      .min(1)
      .max(MAX_MILESTONE_REFERENCE_CHARS)
      .optional()
      .describe("correct only: the whole corrected Python reference, if its output was wrong. Mivra reruns it on every case."),
  })
  .strict();
export type CaseDisputeDecision = z.infer<typeof CaseDisputeDecision>;

/** A check as the learner's page shows it: the results, and the paths of the files sent rather than their text. */
export const MilestoneCheckView = z
  .object({
    results: z.array(MilestoneCaseResult),
    files: z.array(z.string()),
    skipped: z.array(z.object({ path: z.string(), reason: ReviewSkipReason }).strict()).optional(),
    source: z.enum(["git", "none"]).optional(),
  })
  .strict();
export type MilestoneCheckView = z.infer<typeof MilestoneCheckView>;

export const toMilestoneCheckView = (answer: MilestoneCheckAnswer): MilestoneCheckView => ({
  results: answer.results,
  files: (answer.files ?? []).map((f) => f.path),
  ...(answer.skipped?.length ? { skipped: answer.skipped } : {}),
  ...(answer.source ? { source: answer.source } : {}),
});
