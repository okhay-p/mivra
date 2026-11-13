import { describe, expect, it } from "vitest";
import {
  MilestoneCases,
  MilestoneReviewInput,
  reviewVerdict,
  MAX_REVIEW_TOTAL_CHARS,
  MilestoneCheckAnswer,
  ProjectMilestoneInput,
  ProjectMilestoneSpec,
  artifactKinds,
  gradeMilestone,
  toProjectMilestonePublic,
  type MilestoneCaseResult,
} from "../src/index.js";

const input = {
  concept: "tokenizing",
  title: "Count the tokens",
  spec: "Read an expression and print how many tokens it has.",
  outputFormat: "One line: `tokens: N`.",
  checkType: "tests" as const,
  cases: [
    { name: "one number", input: "42" },
    { name: "sum", input: "1 + 2", compare: "stdout" as const },
  ],
  referenceSolution: "import sys\nprint(f'tokens: {len(sys.stdin.read().split())}')\n",
};
const spec: ProjectMilestoneSpec = { ...input, cases: [{ ...input.cases[0]!, expected: "tokens: 1" }, { ...input.cases[1]!, expected: "tokens: 3" }] };
const ok = (stdout: string): MilestoneCaseResult => ({ stdout, exitCode: 0 });

describe("project_milestone", () => {
  it("rejects {} and unknown check types, and accepts a milestone", () => {
    expect(artifactKinds.project_milestone.input.safeParse({}).success).toBe(false);
    expect(ProjectMilestoneInput.safeParse({ ...input, checkType: "other" }).success).toBe(false);
    expect(ProjectMilestoneInput.safeParse({ ...input, cases: [] }).success).toBe(false);
    expect(ProjectMilestoneInput.safeParse({ ...input, referenceSolution: undefined }).success).toBe(false);
    // A review milestone has no cases or reference, and must say what the review looks for.
    const { cases: _cases, referenceSolution: _reference, ...plain } = input;
    expect(ProjectMilestoneInput.safeParse({ ...input, checkType: "review", reviewFocus: "f" }).success).toBe(false);
    expect(ProjectMilestoneInput.safeParse({ ...plain, checkType: "review" }).success).toBe(false);
    expect(artifactKinds.project_milestone.input.safeParse({ ...plain, checkType: "review", reviewFocus: "Uses a loop over characters." }).success).toBe(true);
    expect(artifactKinds.project_milestone.spec.safeParse({}).success).toBe(false);
    expect(artifactKinds.project_milestone.input.safeParse(input).success).toBe(true);
    expect(MilestoneCheckAnswer.safeParse({}).success).toBe(false);
  });

  it("keeps the reference out of the public view", () => {
    const view = toProjectMilestonePublic(spec);
    expect(JSON.stringify(view)).not.toContain("sys.stdin");
    expect(view.cases.map((c) => c.compare)).toEqual(["stdout", "stdout"]);
    expect(view.cases[1]!.expected).toBe("tokens: 3");
  });

  it("passes a case only when it exits 0 with the expected output, after normalising whitespace at line ends", () => {
    expect(gradeMilestone(spec, { results: [ok("tokens: 1  \r\n\n"), ok("tokens: 3")] })).toEqual({ correct: true, passed: 2, total: 2, cases: [{ passed: true, case: 0 }, { passed: true, case: 1 }] });
    const grade = gradeMilestone(spec, {
      results: [{ stdout: "tokens: 1", exitCode: 1 }, { stdout: "tokens: 3", exitCode: null, error: "timeout" }],
    });
    expect(grade.passed).toBe(0);
    expect(gradeMilestone(spec, { results: [{ ...ok("tokens: 1"), truncated: true }, ok(" tokens: 3")] }).passed).toBe(0);
    expect(() => gradeMilestone(spec, { results: [ok("tokens: 1")] })).toThrow(RangeError);
  });

  it("sends cases to the CLI as data only, with no field a command could hide in", () => {
    const cases = { courseId: "c", lessonId: "l", artifactId: "a", position: 1, title: "t", checkType: "tests", revision: "0123abcd", since: null, cases: [{ name: "n", input: "", compare: "stdout" }] };
    expect(MilestoneCases.parse(cases)).toEqual(cases);
    expect(MilestoneCases.safeParse({ ...cases, command: "rm -rf /" }).success).toBe(false);
    // `since` reaches git as an argument, so only a commit id is accepted: never something git could read as an option.
    expect(MilestoneCases.safeParse({ ...cases, since: "a".repeat(40) }).success).toBe(true);
    expect(MilestoneCases.safeParse({ ...cases, since: "--output=/tmp/x" }).success).toBe(false);
    expect(MilestoneCases.safeParse({ ...cases, since: "HEAD" }).success).toBe(false);
  });

  it("grades only the cases not withdrawn, keeping each one's place", () => {
    const withdrawn = { ...spec, cases: [{ ...spec.cases[0]!, withdrawn: true }, spec.cases[1]!] };
    expect(gradeMilestone(withdrawn, { results: [ok("tokens: 3")] })).toEqual({ correct: true, passed: 1, total: 1, cases: [{ passed: true, case: 1 }] });
    expect(() => gradeMilestone(withdrawn, { results: [ok("tokens: 1"), ok("tokens: 3")] })).toThrow(RangeError);
    expect(toProjectMilestonePublic(withdrawn).cases[0]!.withdrawn).toBe(true);
  });

  it("caps what a check sends for review", () => {
    const file = (n: number) => ({ path: `f${n}`, content: "x".repeat(60_000) });
    expect(MilestoneCheckAnswer.safeParse({ results: [], files: [file(1), file(2), file(3), file(4)] }).success).toBe(true);
    expect(4 * 60_000).toBe(MAX_REVIEW_TOTAL_CHARS);
    expect(MilestoneCheckAnswer.safeParse({ results: [], files: [file(1), file(2), file(3), file(4), { path: "g", content: "y" }] }).success).toBe(false);
    expect(MilestoneCheckAnswer.safeParse({ results: [], files: [{ path: "f", content: "x".repeat(60_001) }] }).success).toBe(false);
  });

  it("approves a review only when every criterion passed, whatever the summary says", () => {
    const pass = { passed: true, note: "ok" };
    const input = MilestoneReviewInput.parse({ noHardCodedOutputs: pass, concept: pass, quality: pass, summary: "Great, approved!", suggestions: [] });
    expect(reviewVerdict(input, "m")).toMatchObject({ approved: true, judgedBy: "model", model: "m" });
    expect(reviewVerdict({ ...input, noHardCodedOutputs: { passed: false, note: "canned" } }, "m").approved).toBe(false);
    expect(reviewVerdict({ ...input, quality: { passed: false, note: "x" } }, "m").approved).toBe(false);
  });
});
