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
