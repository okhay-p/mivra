import { describe, expect, it } from "vitest";
import {
  MilestoneCases,
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
    expect(ProjectMilestoneInput.safeParse({ ...input, checkType: "review" }).success).toBe(false);
    expect(ProjectMilestoneInput.safeParse({ ...input, cases: [] }).success).toBe(false);
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
    expect(gradeMilestone(spec, { results: [ok("tokens: 1  \r\n\n"), ok("tokens: 3")] })).toEqual({ correct: true, passed: 2, total: 2, cases: [{ passed: true }, { passed: true }] });
    const grade = gradeMilestone(spec, {
      results: [{ stdout: "tokens: 1", exitCode: 1 }, { stdout: "tokens: 3", exitCode: null, error: "timeout" }],
    });
    expect(grade.passed).toBe(0);
    expect(gradeMilestone(spec, { results: [{ ...ok("tokens: 1"), truncated: true }, ok(" tokens: 3")] }).passed).toBe(0);
    expect(() => gradeMilestone(spec, { results: [ok("tokens: 1")] })).toThrow(RangeError);
  });

  it("sends cases to the CLI as data only, with no field a command could hide in", () => {
    const cases = { courseId: "c", lessonId: "l", artifactId: "a", position: 1, title: "t", checkType: "tests", cases: [{ name: "n", input: "", compare: "stdout" }] };
    expect(MilestoneCases.parse(cases)).toEqual(cases);
    expect(MilestoneCases.safeParse({ ...cases, command: "rm -rf /" }).success).toBe(false);
  });
});
