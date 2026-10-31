import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AlgorithmTraceSpec,
  ArtifactView,
  MultipleChoiceSpec,
  SetDiagramSpec,
  artifactKinds,
  gradeMultipleChoice,
  kindForTool,
  setRegionKey,
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

describe("set_diagram", () => {
  const sets = [
    { id: "a", label: "$A$" },
    { id: "b", label: "$B$" },
    { id: "c", label: "Multiples of 3" },
  ];
  const diagram = {
    title: "Inclusion-exclusion",
    sets,
    universe: "$U$",
    regions: [
      { in: ["a"], elements: [1, "x"] },
      { in: ["a", "b"], elements: [3], count: 4 },
      { in: [], elements: [] },
    ],
    steps: [{ explanation: "The overlap.", highlights: [{ in: ["b", "a"], tone: "done" }, { in: [] }], variables: [{ name: "n", value: 4 }] }],
  };
  const parse = (changes: object) => SetDiagramSpec.safeParse({ ...diagram, ...changes });
  const messages = (changes: object) => JSON.stringify(parse(changes).error?.issues.map((i) => i.message));

  it("accepts a full diagram, and one with neither steps nor universe", () => {
    expect(parse({}).success).toBe(true);
    expect(SetDiagramSpec.safeParse({ title: "One", sets: [sets[0]], regions: [] }).success).toBe(true);
  });

  it("needs 1 to 3 sets with unique ids", () => {
    expect(parse({ sets: [] }).success).toBe(false);
    expect(parse({ sets: [...sets, { id: "d", label: "D" }] }).success).toBe(false);
    expect(messages({ sets: [sets[0], sets[1], { id: "a", label: "again" }] })).toContain('duplicate set id \\"a\\"');
  });

  it("rejects a region or highlight naming an unknown set, or the same set twice", () => {
    expect(messages({ regions: [{ in: ["z"], elements: [] }] })).toContain('unknown set \\"z\\"');
    expect(messages({ steps: [{ explanation: "x", highlights: [{ in: ["z"] }] }] })).toContain('unknown set \\"z\\"');
    expect(messages({ regions: [{ in: ["a", "a"], elements: [] }] })).toContain("named twice");
  });

  it("treats reordered ids as the same region", () => {
    expect(setRegionKey(["b", "a"])).toBe(setRegionKey(["a", "b"]));
    expect(setRegionKey(["a"])).not.toBe(setRegionKey(["a", "b"]));
    const twice = [
      { in: ["a", "b"], elements: [] },
      { in: ["b", "a"], elements: [] },
    ];
    expect(messages({ regions: twice })).toContain("more than once");
    expect(messages({ steps: [{ explanation: "x", highlights: [{ in: ["a", "c"] }, { in: ["c", "a"], tone: "muted" }] }] })).toContain("more than once");
  });

  it("needs a universe for the region outside every set", () => {
    const { universe: _, ...noUniverse } = diagram;
    const without = (changes: object) => SetDiagramSpec.safeParse({ ...noUniverse, steps: undefined, regions: [], ...changes });
    expect(without({}).success).toBe(true);
    expect(without({ regions: [{ in: [], elements: [1] }] }).success).toBe(false);
    expect(without({ steps: [{ explanation: "x", highlights: [{ in: [] }] }] }).success).toBe(false);
  });

  it("keeps an element to one region, and a count at least what's listed", () => {
    const placedTwice = [
      { in: ["a"], elements: [1] },
      { in: ["b"], elements: ["1"] },
    ];
    expect(messages({ regions: placedTwice })).toContain("more than once");
    expect(messages({ regions: [{ in: ["a"], elements: [1, 2], count: 1 }] })).toContain("less than");
  });

  it("bounds elements, steps and text", () => {
    const elements = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(parse({ regions: [{ in: ["a"], elements: elements(30) }] }).success).toBe(true);
    expect(parse({ regions: [{ in: ["a"], elements: elements(31) }] }).success).toBe(false);
    expect(parse({ regions: [{ in: ["a"], elements: ["x".repeat(25)] }] }).success).toBe(false);
    const step = { explanation: "x" };
    expect(parse({ steps: Array(40).fill(step) }).success).toBe(true);
    expect(parse({ steps: Array(41).fill(step) }).success).toBe(false);
    expect(parse({ steps: [] }).success).toBe(false);
    expect(parse({ regions: [{ in: ["a"], elements: [], extra: 1 }] }).success).toBe(false);
  });

  it("tells the model highlights belong to their own step", () => {
    type Node = { description?: string; properties?: Record<string, Node>; items?: Node };
    const schema = z.toJSONSchema(artifactKinds.set_diagram.spec) as Node;
    expect(schema.properties!.steps!.items!.properties!.highlights!.description).toMatch(/this step only/);
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
