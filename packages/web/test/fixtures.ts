import type { ArtifactView } from "@mivra/protocol";

export const trace = {
  id: "art-trace",
  createdAt: "2026-10-30T00:00:00.000Z",
  kind: "algorithm_trace",
  version: 1,
  spec: {
    title: "Swap demo",
    values: [3, 1, 2],
    steps: [
      {
        explanation: "Compare the first two.",
        pointers: [{ name: "i", index: 0 }],
        ranges: [{ start: 0, end: 1, label: "pair", tone: "active" }],
        variables: [{ name: "swaps", value: 0 }],
      },
      { explanation: "Swap them.", values: [1, 3, 2] },
      { explanation: "Move on.", pointers: [{ name: "i", index: 1 }] },
    ],
  },
} satisfies ArtifactView;

export const graph = {
  id: "art-graph",
  createdAt: "2026-10-30T00:00:00.000Z",
  kind: "graph",
  version: 1,
  spec: {
    title: "Walk",
    directed: true,
    nodes: [{ id: "a", label: "start" }, { id: "b" }, { id: "c" }],
    edges: [
      { from: "a", to: "b", weight: 4 },
      { from: "a", to: "a", weight: 1 },
      { from: "b", to: "c", label: "go" },
    ],
    steps: [
      {
        explanation: "Begin at the start.",
        nodeStates: [{ id: "a" }],
        edgeStates: [{ from: "a", to: "b" }, { from: "a", to: "a", tone: "muted" }],
        variables: [{ name: "dist", value: 0 }],
      },
      { explanation: "Move on.", nodeStates: [{ id: "a", tone: "done" }, { id: "b", tone: "active" }], edgeStates: [{ from: "b", to: "c", tone: "done" }] },
      { explanation: "Nothing highlighted." },
    ],
  },
} satisfies ArtifactView;

export const venn = {
  id: "art-venn",
  createdAt: "2026-10-30T00:00:00.000Z",
  kind: "set_diagram",
  version: 1,
  spec: {
    title: "Three sets",
    sets: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    universe: "U",
    regions: [
      { in: ["a"], elements: [1, 2] },
      { in: ["b", "a"], elements: [3, 5] },
      { in: ["a", "b", "c"], elements: [] },
      { in: ["c"], elements: [], count: 7 },
      { in: [], elements: [9] },
    ],
    steps: [
      { explanation: "Look at the overlap.", highlights: [{ in: ["b", "a"] }, { in: [], tone: "muted" }], variables: [{ name: "size", value: 2 }] },
      { explanation: "Nothing highlighted here." },
      { explanation: "Now the middle.", highlights: [{ in: ["a", "b", "c"], tone: "done" }] },
    ],
  },
} satisfies ArtifactView;

export const question = {
  id: "art-mc",
  createdAt: "2026-10-30T00:00:00.000Z",
  kind: "multiple_choice",
  version: 1,
  spec: {
    concept: "sliding window",
    question: "When does the window shrink?",
    options: [{ text: "Never" }, { text: "When the sum is too big" }, { text: "Every step" }],
  },
} satisfies ArtifactView;

export const answered = {
  ...question,
  latestAttempt: {
    answer: { optionIndex: 0 },
    grade: {
      correct: false,
      correctOptionIndex: 1,
      explanation: "Shrink to restore the invariant.",
      feedback: "It has to shrink at some point.",
    },
    createdAt: "2026-10-30T00:01:00.000Z",
  },
} satisfies ArtifactView;

export const truthTable = {
  id: "art-table",
  createdAt: "2026-10-30T00:00:00.000Z",
  kind: "table",
  version: 1,
  spec: {
    title: "Truth table for $p \\land q$",
    columns: ["$p$", "$q$", "$p \\land q$"],
    rows: [
      [true, true, ""],
      [true, false, ""],
    ],
    steps: [
      { explanation: "Read the inputs.", highlight: [{ column: 0 }, { column: 1, tone: "done" }] },
      { explanation: "Both are true.", highlight: [{ row: 0 }], cells: [{ row: 0, column: 2, value: true }] },
      { explanation: "One is false, so $p \\land q$ is false.", highlight: [{ row: 1, column: 2, tone: "muted" }], cells: [{ row: 1, column: 2, value: false }] },
    ],
  },
} satisfies ArtifactView;

export const relationMatrix = {
  id: "art-matrix",
  createdAt: "2026-10-30T00:00:00.000Z",
  kind: "table",
  version: 1,
  spec: {
    title: "Relation $R$",
    columns: ["$a$", "b"],
    rowHeaders: ["$a$", "b"],
    rows: [
      [1, "2*3*4"],
      ["|x|", false],
    ],
  },
} satisfies ArtifactView;

export const induction = {
  id: "art-worked",
  createdAt: "2026-10-30T00:00:00.000Z",
  kind: "worked_steps",
  version: 1,
  spec: {
    title: "Sum of the first $n$ integers",
    goal: "Show $\\sum_{i=1}^n i = n(n+1)/2$",
    steps: [
      { label: "Base case", statement: "$1 = 1(1+1)/2$", justification: "by direct calculation, 2*3*4 aside" },
      { statement: "Assume $P(k)$", justification: "the inductive hypothesis" },
      { label: "Inductive step", statement: "$\\displaystyle \\sum_{i=1}^{k+1} i = \\frac{(k+1)(k+2)}{2}$", justification: "by $P(k)$" },
    ],
  },
} satisfies ArtifactView;
