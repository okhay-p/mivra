import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AlgorithmTraceSpec,
  ArtifactView,
  MultipleChoiceSpec,
  TableSpec,
  WorkedStepsSpec,
  artifactKinds,
  gradeMultipleChoice,
  kindForTool,
  toMultipleChoicePublic,
  type ArtifactKind,
} from "../src/index.js";

const slidingWindow = {
  title: "Max sum of a window of size 3",
  values: [2, 1, 5, 1, 3, 2],
  steps: [
    {
      explanation: "Sum the first window: 2 + 1 + 5 = 8.",
      ranges: [{ start: 0, end: 2, label: "window" }],
      variables: [
        { name: "sum", value: 8 },
        { name: "best", value: 8 },
      ],
    },
    {
      explanation: "Slide right: drop 2, add 1. Sum is 7.",
      pointers: [
        { name: "left", index: 1 },
        { name: "right", index: 3 },
      ],
      ranges: [{ start: 1, end: 3, label: "window" }],
      variables: [
        { name: "sum", value: 7 },
        { name: "best", value: 8 },
      ],
    },
  ],
};

const binarySearchCheck = {
  concept: "binary search worst case",
  question: "Worst-case comparisons for binary search on 16 sorted items?",
  options: [
    { text: "3" },
    { text: "4", feedback: "Close: 2^4 = 16, but you need one more comparison to confirm." },
    { text: "5" },
    { text: "16", feedback: "That is linear search." },
  ],
  correctOptionIndex: 2,
  explanation: "Each comparison halves the range: 16, 8, 4, 2, 1, so 5 comparisons in the worst case.",
};

describe("every artifact kind", () => {
  const kinds = Object.keys(artifactKinds) as ArtifactKind[];

  it.each(kinds)("%s rejects an empty object (truncated tool arguments arrive as {})", (kind) => {
    expect(artifactKinds[kind].spec.safeParse({}).success).toBe(false);
  });

  it.each(kinds)("%s converts to a JSON Schema object with required fields, for the tool definition", (kind) => {
    const schema = z.toJSONSchema(artifactKinds[kind].spec) as { type: string; required?: string[]; additionalProperties?: boolean };
    expect(schema.type).toBe("object");
    expect(schema.required?.length).toBeGreaterThan(0);
    expect(schema.additionalProperties).toBe(false);
  });

  it("keeps nested objects strict, optional fields optional and descriptions visible to the model", () => {
    type Node = { type?: string; required?: string[]; additionalProperties?: boolean; description?: string; maxItems?: number; properties?: Record<string, Node>; items?: Node };
    const trace = z.toJSONSchema(artifactKinds.algorithm_trace.spec) as Node;
    const step = trace.properties!.steps!.items!;
    expect(step.additionalProperties).toBe(false);
    expect(step.required).toEqual(["explanation"]);
    expect(step.properties!.pointers!.description).toMatch(/Not carried over/);
    expect(step.properties!.pointers!.maxItems).toBe(8);
    const range = step.properties!.ranges!.items!;
    expect(range.additionalProperties).toBe(false);
    expect(range.properties!.end!.description).toMatch(/>= start/);

    const check = z.toJSONSchema(artifactKinds.multiple_choice.spec) as Node;
    const option = check.properties!.options!.items!;
    expect(option.additionalProperties).toBe(false);
    expect(option.required).toEqual(["text"]);
    expect(check.properties!.options!.description).toMatch(/distinct/);
  });

  it("has unique tool names that map back to their kind", () => {
    const names = kinds.map((k) => artifactKinds[k].toolName);
    expect(new Set(names).size).toBe(names.length);
    for (const kind of kinds) expect(kindForTool(artifactKinds[kind].toolName)).toBe(kind);
    expect(kindForTool("not_a_tool")).toBeUndefined();
  });
});

describe("algorithm_trace", () => {
  it("accepts a sliding-window trace", () => {
    expect(AlgorithmTraceSpec.parse(slidingWindow)).toEqual(slidingWindow);
  });

  it("rejects a pointer outside the sequence", () => {
    const bad = structuredClone(slidingWindow);
    bad.steps[1]!.pointers![1]!.index = 6;
    const result = AlgorithmTraceSpec.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["steps", 1, "pointers", 1, "index"]);
  });

  it("rejects a range that ends past the sequence or runs backwards", () => {
    const pastEnd = structuredClone(slidingWindow);
    pastEnd.steps[0]!.ranges![0]!.end = 6;
    expect(AlgorithmTraceSpec.safeParse(pastEnd).success).toBe(false);

    const backwards = structuredClone(slidingWindow);
    backwards.steps[0]!.ranges![0] = { start: 2, end: 1, label: "window" };
    expect(AlgorithmTraceSpec.safeParse(backwards).success).toBe(false);
  });

  it("checks bounds against the sequence as it is at each step", () => {
    const shrinks = {
      title: "t",
      values: [1, 2, 3, 4],
      steps: [
        { explanation: "Drop the last value.", values: [1, 2, 3] },
        { explanation: "Point at the old last index.", pointers: [{ name: "i", index: 3 }] },
      ],
    };
    expect(AlgorithmTraceSpec.safeParse(shrinks).success).toBe(false);
    shrinks.steps[1]!.pointers![0]!.index = 2;
    expect(AlgorithmTraceSpec.safeParse(shrinks).success).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(AlgorithmTraceSpec.safeParse({ ...slidingWindow, html: "<script>" }).success).toBe(false);
  });
});

describe("multiple_choice", () => {
  it("accepts a valid check", () => {
    expect(MultipleChoiceSpec.parse(binarySearchCheck)).toEqual(binarySearchCheck);
  });

  it("rejects a correct index outside the options", () => {
    expect(MultipleChoiceSpec.safeParse({ ...binarySearchCheck, correctOptionIndex: 4 }).success).toBe(false);
  });

  it("rejects fewer than two options", () => {
    expect(MultipleChoiceSpec.safeParse({ ...binarySearchCheck, options: [{ text: "5" }], correctOptionIndex: 0 }).success).toBe(
      false,
    );
  });

  it("rejects options that are identical after trimming", () => {
    const dup = { ...binarySearchCheck, options: [{ text: "five" }, { text: "  five " }, { text: "4" }], correctOptionIndex: 0 };
    const result = MultipleChoiceSpec.safeParse(dup);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["options", 1, "text"]);
  });

  it("treats Unicode spellings that render identically as duplicates", () => {
    const composed = "caf\u00e9"; // é as one code point
    const decomposed = "cafe\u0301"; // e + combining accent
    const options = [{ text: composed }, { text: decomposed }];
    expect(MultipleChoiceSpec.safeParse({ ...binarySearchCheck, options, correctOptionIndex: 0 }).success).toBe(false);
  });

  it.each([
    ["case", "A", "a"],
    ["inner spacing", '"a b"', '"a  b"'],
    ["number formatting", "5", "5.0"],
  ])("keeps options that differ only by %s, since that can be what the question tests", (_label, first, second) => {
    const options = [{ text: first }, { text: second }];
    expect(MultipleChoiceSpec.safeParse({ ...binarySearchCheck, options, correctOptionIndex: 0 }).success).toBe(true);
  });

  it("grades deterministically, with per-option feedback", () => {
    const spec = MultipleChoiceSpec.parse(binarySearchCheck);
    expect(gradeMultipleChoice(spec, { optionIndex: 2 })).toEqual({
      correct: true,
      correctOptionIndex: 2,
      explanation: binarySearchCheck.explanation,
    });
    expect(gradeMultipleChoice(spec, { optionIndex: 1 })).toEqual({
      correct: false,
      correctOptionIndex: 2,
      explanation: binarySearchCheck.explanation,
      feedback: "Close: 2^4 = 16, but you need one more comparison to confirm.",
    });
  });

  it("refuses to grade an option that doesn't exist", () => {
    expect(() => gradeMultipleChoice(MultipleChoiceSpec.parse(binarySearchCheck), { optionIndex: 9 })).toThrow(RangeError);
  });

  it("keeps the answer key and feedback out of the public view", () => {
    const view = toMultipleChoicePublic(MultipleChoiceSpec.parse(binarySearchCheck));
    const json = JSON.stringify(view);
    expect(json).not.toContain("correctOptionIndex");
    expect(json).not.toContain("feedback");
    expect(json).not.toContain(binarySearchCheck.explanation);
  });
});

describe("ArtifactView", () => {
  const base = { id: "a1", createdAt: new Date(0).toISOString(), version: 1 as const };

  it("accepts both kinds in their client shape", () => {
    expect(ArtifactView.safeParse({ ...base, kind: "algorithm_trace", spec: slidingWindow }).success).toBe(true);
    const publicSpec = toMultipleChoicePublic(MultipleChoiceSpec.parse(binarySearchCheck));
    expect(ArtifactView.safeParse({ ...base, kind: "multiple_choice", spec: publicSpec }).success).toBe(true);
  });

  it("rejects a multiple-choice view that would leak the answer key", () => {
    expect(ArtifactView.safeParse({ ...base, kind: "multiple_choice", spec: binarySearchCheck }).success).toBe(false);
  });

  it("includes the grade once the learner has answered", () => {
    const spec = MultipleChoiceSpec.parse(binarySearchCheck);
    const view = {
      ...base,
      kind: "multiple_choice",
      spec: toMultipleChoicePublic(spec),
      latestAttempt: {
        answer: { optionIndex: 1 },
        grade: gradeMultipleChoice(spec, { optionIndex: 1 }),
        createdAt: new Date(0).toISOString(),
      },
    };
    expect(ArtifactView.safeParse(view).success).toBe(true);
  });
});

describe("table", () => {
  const truthTable = {
    title: "Truth table for $p \\land q$",
    columns: ["$p$", "$q$", "$p \\land q$"],
    rows: [
      [true, true, ""],
      [true, false, ""],
    ],
    steps: [
      { explanation: "Both true.", highlight: [{ row: 0 }, { column: 2, tone: "done" }, { row: 0, column: 2, tone: "muted" }], cells: [{ row: 0, column: 2, value: true }] },
      { explanation: "One false.", cells: [{ row: 1, column: 2, value: false }] },
    ],
  };
  const issuePaths = (input: unknown) => TableSpec.safeParse(input).error?.issues.map((issue) => issue.path.join("."));

  it("accepts a stepped truth table and a static matrix with row headers", () => {
    expect(TableSpec.parse(truthTable)).toEqual(truthTable);
    const matrix = { title: "R", columns: ["a", "b"], rowHeaders: ["a", "b"], rows: [[1, 0], [0, 1]] };
    expect(TableSpec.parse(matrix)).toEqual(matrix);
  });

  it("rejects a row that doesn't match the column count", () => {
    expect(issuePaths({ ...truthTable, rows: [[true, true, ""], [true, false]] })).toEqual(["rows.1"]);
  });

  it("rejects the wrong number of row headers", () => {
    expect(issuePaths({ ...truthTable, rowHeaders: ["only one"] })).toEqual(["rowHeaders"]);
  });

  it("rejects out-of-range highlights and cell changes at the step they appear in", () => {
    const steps = [
      { explanation: "ok", highlight: [{ row: 1, column: 2 }] },
      { explanation: "bad", highlight: [{ row: 2 }, { column: 3 }], cells: [{ row: 2, column: 0, value: 1 }, { row: 0, column: 3, value: 1 }] },
    ];
    expect(issuePaths({ ...truthTable, steps })).toEqual([
      "steps.1.highlight.0.row",
      "steps.1.highlight.1.column",
      "steps.1.cells.0.row",
      "steps.1.cells.1.column",
    ]);
  });

  it("rejects a highlight with neither a row nor a column, and unknown fields", () => {
    expect(issuePaths({ ...truthTable, steps: [{ explanation: "x", highlight: [{ tone: "done" }] }] })).toEqual(["steps.0.highlight.0"]);
    expect(TableSpec.safeParse({ ...truthTable, extra: 1 }).success).toBe(false);
    expect(TableSpec.safeParse({ ...truthTable, steps: [{ explanation: "x", highlight: [{ row: 0, cell: 1 }] }] }).success).toBe(false);
  });

  it("enforces its limits", () => {
    const base = { title: "T", columns: ["a"], rows: [[1]] };
    const of = <T,>(n: number, item: T) => Array.from({ length: n }, () => item);
    expect(TableSpec.safeParse({ ...base, columns: of(17, "a"), rows: [of(17, 1)] }).success).toBe(false);
    expect(TableSpec.safeParse({ ...base, columns: of(16, "a"), rows: [of(16, 1)] }).success).toBe(true);
    expect(TableSpec.safeParse({ ...base, rows: of(65, [1]) }).success).toBe(false);
    expect(TableSpec.safeParse({ ...base, rows: of(64, [1]) }).success).toBe(true);
    expect(TableSpec.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(TableSpec.safeParse({ ...base, steps: of(101, { explanation: "x" }) }).success).toBe(false);
    expect(TableSpec.safeParse({ ...base, rows: [["x".repeat(121)]] }).success).toBe(false);
    expect(TableSpec.safeParse({ ...base, steps: [{ explanation: "x", highlight: of(33, { row: 0 }) }] }).success).toBe(false);
    expect(TableSpec.safeParse({ ...base, steps: [{ explanation: "x", cells: of(65, { row: 0, column: 0, value: 1 }) }] }).success).toBe(false);
  });

  it("passes the strict view, which rejects extra fields", () => {
    const view = { id: "a", createdAt: "2026-10-31T00:00:00.000Z", kind: "table", version: 1, spec: truthTable };
    expect(ArtifactView.safeParse(view).success).toBe(true);
    expect(ArtifactView.safeParse({ ...view, latestAttempt: {} }).success).toBe(false);
  });
});

describe("worked_steps", () => {
  const induction = {
    title: "Sum of the first $n$ integers",
    goal: "$\\sum_{i=1}^n i = n(n+1)/2$",
    steps: [
      { label: "Base case", statement: "$1 = 1(2)/2$", justification: "by calculation" },
      { statement: "$\\displaystyle \\sum_{i=1}^{k+1} i = k(k+1)/2 + k + 1$", justification: "by the inductive hypothesis" },
    ],
  };

  it("accepts an induction proof, with the goal and labels optional", () => {
    expect(WorkedStepsSpec.parse(induction)).toEqual(induction);
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: [{ statement: "s", justification: "j" }] }).success).toBe(true);
  });

  it("requires a statement and a justification, and rejects unknown fields", () => {
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: [{ statement: "s" }] }).success).toBe(false);
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: [{ justification: "j" }] }).success).toBe(false);
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: [{ statement: "s", justification: "j", extra: 1 }] }).success).toBe(false);
  });

  it("enforces its limits", () => {
    const step = { statement: "s", justification: "j" };
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: [] }).success).toBe(false);
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: Array.from({ length: 51 }, () => step) }).success).toBe(false);
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: [{ ...step, statement: "x".repeat(1001) }] }).success).toBe(false);
    expect(WorkedStepsSpec.safeParse({ title: "T", steps: [{ ...step, justification: "x".repeat(501) }] }).success).toBe(false);
  });

  it("passes the strict view", () => {
    const view = { id: "a", createdAt: "2026-10-31T00:00:00.000Z", kind: "worked_steps", version: 1, spec: induction };
    expect(ArtifactView.safeParse(view).success).toBe(true);
    expect(ArtifactView.safeParse({ ...view, extra: 1 }).success).toBe(false);
  });
});
