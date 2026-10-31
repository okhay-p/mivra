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
