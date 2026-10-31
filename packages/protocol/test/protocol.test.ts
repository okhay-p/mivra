import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AlgorithmTraceSpec,
  ArtifactView,
  GraphSpec,
  MultipleChoiceSpec,
  SetDiagramSpec,
  TableSpec,
  WorkedStepsSpec,
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

  it("keeps elements unique within a list too, whether written as a number or a string", () => {
    expect(messages({ regions: [{ in: ["a"], elements: [1, 1] }] })).toContain("more than once");
    expect(messages({ regions: [{ in: ["a"], elements: [1, "1"] }] })).toContain("more than once");
  });

  it("keeps what's drawn in the diagram to one line", () => {
    expect(messages({ regions: [{ in: ["a"], elements: ["1\n2\n3\n4\n5\n6"] }] })).toContain("line breaks");
    for (const elements of [["1\r2"], ["1\u20282"]]) expect(parse({ regions: [{ in: ["a"], elements }] }).success).toBe(false);
    expect(parse({ universe: "U\nV" }).success).toBe(false);
    expect(parse({ sets: [{ id: "a", label: "A\nB" }] }).success).toBe(false);
    expect(parse({ regions: [{ in: ["a"], elements: ["a b"] }] }).success).toBe(true);
  });

  it("tells the model every uniqueness rule", () => {
    const { regions } = SetDiagramSpec.shape;
    const region = regions.element;
    expect(region.shape.in.description).toContain("No id twice");
    expect(region.shape.elements.description).toMatch(/twice.*across regions.*1 and "1"/);
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

  describe("edge sides", () => {
    const tree = (edges: object[], extra: object = {}) => ({ title: "t", directed: true, kind: "tree", nodes: [{ id: "r" }, { id: "x" }, { id: "y" }, { id: "z" }].slice(0, edges.length + 1), edges, ...extra });
    const l = { from: "r", to: "x", side: "left" };
    const r = { from: "r", to: "y", side: "right" };

    it("accepts a lone left child, a lone right child, and one of each", () => {
      expect(GraphSpec.safeParse(tree([l])).success).toBe(true);
      expect(GraphSpec.safeParse(tree([{ ...l, side: "right" }])).success).toBe(true);
      expect(GraphSpec.safeParse(tree([r, l])).success).toBe(true);
      expect(GraphSpec.safeParse(tree([{ ...l }, { from: "x", to: "y", side: "right" }], { directed: false })).success).toBe(true);
    });

    it("rejects any other side", () => {
      expect(GraphSpec.safeParse(tree([{ ...l, side: "middle" }])).success).toBe(false);
    });

    it("only allows it on a tree", () => {
      expect(issues(tree([l], { kind: "graph" }))).toContain('side only applies when kind is "tree"');
      expect(issues(tree([l], { kind: undefined }))).toContain('side only applies when kind is "tree"');
    });

    it("rejects it when kind is tree but the graph isn't one", () => {
      const cycle = { title: "t", directed: false, kind: "tree", nodes: [{ id: "r" }, { id: "x" }, { id: "y" }], edges: [l, { from: "x", to: "y" }, { from: "y", to: "r" }] };
      expect(issues(cycle)).toContain("side needs a real tree");
    });

    it("rejects two children on one side", () => {
      expect(issues(tree([l, { ...r, side: "left" }]))).toContain("node r has two left children");
      expect(issues(tree([{ ...l, side: "right" }, r]))).toContain("node r has two right children");
    });

    it("rejects a node mixing sided and unsided children", () => {
      expect(issues(tree([l, { from: "r", to: "y" }]))).toContain("node r mixes children");
    });

    it("rejects an undirected edge written child first, which would put the side on the wrong node", () => {
      const swapped = tree([{ from: "x", to: "r", side: "left" }], { directed: false });
      expect(issues(swapped)).toContain("side needs from to be the parent");
    });

    it("reports a dangling edge rather than choking on it", () => {
      expect(issues(tree([{ ...l, to: "zz" }]))).toContain("no node has id zz");
    });
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

describe("table", () => {
  it("tells providers the rules JSON Schema can't express", async () => {
    const { TableHighlight, TableCellChange } = await import("../src/table.js");
    expect(TableHighlight.shape.row.description).toMatch(/below the number of rows/);
    expect(TableHighlight.shape.row.description).toMatch(/a row, a column or both/);
    expect(TableHighlight.shape.column.description).toMatch(/below the number of columns/);
    expect(TableCellChange.shape.row.description).toMatch(/below the number of rows/);
    expect(TableCellChange.shape.column.description).toMatch(/below the number of columns/);
  });

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
