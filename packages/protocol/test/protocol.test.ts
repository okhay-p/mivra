import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AlgorithmTraceSpec,
  ArtifactView,
  GraphSpec,
  MultipleChoiceSpec,
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

describe("graph", () => {
  const graph = {
    title: "BFS",
    directed: true,
    nodes: [{ id: "a", label: "$v_0$" }, { id: "b" }, { id: "c" }],
    edges: [{ from: "a", to: "b", weight: 2 }, { from: "b", to: "c", label: "x" }],
    steps: [
      { explanation: "Start.", nodeStates: [{ id: "a" }], edgeStates: [{ from: "a", to: "b", tone: "muted" }], variables: [{ name: "queue", value: "a" }] },
      { explanation: "Next." },
    ],
  };
  const issues = (spec: unknown) => GraphSpec.safeParse(spec).error?.issues.map((issue) => issue.message).join("; ") ?? "";
  const withStep = (step: object, spec: object = graph) => ({ ...spec, steps: [{ explanation: "x", ...step }] });
  const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));

  it("accepts a stepped graph, and one with no steps or edges", () => {
    expect(GraphSpec.safeParse(graph).success).toBe(true);
    expect(GraphSpec.safeParse({ title: "One", directed: false, kind: "tree", nodes: [{ id: "a" }], edges: [] }).success).toBe(true);
  });

  it("rejects {}, no nodes, unknown fields and coordinates", () => {
    expect(GraphSpec.safeParse({}).success).toBe(false);
    expect(GraphSpec.safeParse({ ...graph, nodes: [], edges: [], steps: undefined }).success).toBe(false);
    expect(GraphSpec.safeParse({ ...graph, nodes: [{ id: "a", x: 1, y: 2 }], edges: [], steps: undefined }).success).toBe(false);
    expect(GraphSpec.safeParse({ ...graph, steps: [] }).success).toBe(false);
  });

  it("rejects duplicate ids and dangling edges", () => {
    expect(issues({ ...graph, nodes: [...graph.nodes, { id: "a" }] })).toContain("duplicate node id a");
    expect(issues({ ...graph, edges: [{ from: "a", to: "zz" }], steps: undefined })).toContain("no node has id zz");
    expect(issues({ ...graph, edges: [{ from: "zz", to: "a" }], steps: undefined })).toContain("no node has id zz");
  });

  it("rejects an edge with both a weight and a label", () => {
    expect(issues({ ...graph, edges: [{ from: "a", to: "b", weight: 1, label: "x" }], steps: undefined })).toContain("not both");
  });

  it("allows self-loops and parallel edges", () => {
    const multigraph = { ...graph, edges: [{ from: "a", to: "a" }, { from: "a", to: "b" }, { from: "a", to: "b" }], steps: undefined };
    expect(GraphSpec.safeParse(multigraph).success).toBe(true);
  });

  it("rejects step references to things that don't exist", () => {
    expect(issues(withStep({ nodeStates: [{ id: "zz" }] }))).toContain("no node has id zz");
    expect(issues(withStep({ edgeStates: [{ from: "a", to: "c" }] }))).toContain("no edge a -> c");
    // Direction counts in a directed graph, but not in an undirected one.
    expect(issues(withStep({ edgeStates: [{ from: "b", to: "a" }] }))).toContain("no edge b -> a");
    expect(GraphSpec.safeParse(withStep({ edgeStates: [{ from: "b", to: "a" }] }, { ...graph, directed: false })).success).toBe(true);
  });

  it("rejects two states for one thing in a step", () => {
    expect(issues(withStep({ nodeStates: [{ id: "a" }, { id: "a", tone: "done" }] }))).toContain("two states");
    expect(issues(withStep({ edgeStates: [{ from: "a", to: "b" }, { from: "a", to: "b", tone: "done" }] }))).toContain("two states");
  });

  it("makes a reference to a parallel edge say which one", () => {
    const parallel = { ...graph, edges: [{ from: "a", to: "b" }, { from: "a", to: "b" }] };
    expect(issues(withStep({ edgeStates: [{ from: "a", to: "b" }] }, parallel))).toContain("set nth");
    expect(issues(withStep({ edgeStates: [{ from: "a", to: "b", nth: 2 }] }, parallel))).toContain("out of range");
    expect(GraphSpec.safeParse(withStep({ edgeStates: [{ from: "a", to: "b", nth: 1 }, { from: "a", to: "b", nth: 0 }] }, parallel)).success).toBe(true);
  });

  it("keeps ids with odd characters apart when matching edges", () => {
    const odd = { title: "t", directed: false, nodes: [{ id: "a,b" }, { id: "c" }, { id: "a" }, { id: "b,c" }], edges: [{ from: "a,b", to: "c" }] };
    expect(issues(withStep({ edgeStates: [{ from: "a", to: "b,c" }] }, odd))).toContain("no edge");
  });

  it("enforces the limits", () => {
    const edge = { from: "n0", to: "n1" };
    const big = { title: "t", directed: false, nodes: nodes(60) };
    expect(GraphSpec.safeParse({ ...big, edges: Array(200).fill(edge) }).success).toBe(true);
    expect(GraphSpec.safeParse({ ...big, edges: Array(201).fill(edge) }).success).toBe(false);
    expect(GraphSpec.safeParse({ title: "t", directed: false, nodes: nodes(61), edges: [] }).success).toBe(false);
    const step = { explanation: "x" };
    expect(GraphSpec.safeParse({ ...big, edges: [], steps: Array(200).fill(step) }).success).toBe(true);
    expect(GraphSpec.safeParse({ ...big, edges: [], steps: Array(201).fill(step) }).success).toBe(false);
    expect(GraphSpec.safeParse({ ...big, edges: [], title: "x".repeat(121) }).success).toBe(false);
    expect(GraphSpec.safeParse({ title: "t", directed: false, nodes: [{ id: "a", label: "x".repeat(25) }], edges: [] }).success).toBe(false);
  });

  it("is registered as show_graph and fits ArtifactView", () => {
    expect(kindForTool("show_graph")).toBe("graph");
    const view = { id: "x", createdAt: new Date().toISOString(), kind: "graph", version: 1, spec: graph };
    expect(ArtifactView.safeParse(view).success).toBe(true);
    expect(ArtifactView.safeParse({ ...view, spec: { ...graph, nodes: [] } }).success).toBe(false);
  });
});
