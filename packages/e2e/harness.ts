import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createApp } from "../server/src/app.js";
import { openDb } from "../server/src/db/client.js";
import { loadOrCreateToken } from "../server/src/security.js";
import { serveWeb } from "../server/src/serve-web.js";

/**
 * The real server, database and built UI with a scripted model, so browser tests need no API key.
 * The model picks its script from the learner's latest message and its step from the tool results
 * since then, the way a real model continues after a tool call.
 */

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const trace = {
  title: "Swap demo",
  values: [3, 1, 2],
  steps: [
    {
      explanation: "Compare the first two.",
      pointers: [{ name: "i", index: 0 }],
      ranges: [{ start: 0, end: 1, label: "pair" }],
      variables: [{ name: "swaps", value: 0 }],
    },
    { explanation: "Swap them.", values: [1, 3, 2] },
    { explanation: "Move on.", pointers: [{ name: "i", index: 1 }] },
  ],
};

const check = {
  concept: "swapping",
  question: "How many swaps did that take?",
  options: [{ text: "None", feedback: "SECRET-FEEDBACK: one swap happened." }, { text: "One" }, { text: "Two" }],
  correctOptionIndex: 1,
  explanation: "SECRET-EXPLANATION: 3 and 1 swapped once.",
};

const longWord = "calculateMaximumSlidingWindowSumWithoutRecomputingEveryElement";
// The longest value the trace schema allows.
const longValue = "calculateMaximumWindowSu";
const wideTrace = { title: "Long values", values: [longValue, longValue, longValue], steps: [{ explanation: "Too wide to fit.", pointers: [{ name: "i", index: 0 }] }] };
const wideCheck = {
  concept: "long answers",
  question: "Which name is right?",
  options: [{ text: `${longWord}A` }, { text: `${longWord}B` }],
  correctOptionIndex: 1,
  explanation: "The second one.",
};

const ALL_REGIONS = [["a"], ["b"], ["c"], ["a", "b"], ["a", "c"], ["b", "c"], ["a", "b", "c"], []];
const venn = {
  title: "Small numbers, $A \\cap B$",
  sets: [
    { id: "a", label: "$A$" },
    { id: "b", label: "$B$" },
    { id: "c", label: "Multiples of 3" },
  ],
  universe: "$U$",
  regions: [
    { in: ["a"], elements: [1, 2] },
    { in: ["b"], elements: [4] },
    { in: ["c"], elements: [9, "$x^2$"] },
    { in: ["b", "a"], elements: [5, 7] },
    { in: ["a", "c"], elements: [] },
    { in: ["b", "c"], elements: [12] },
    { in: ["a", "b", "c"], elements: [3, 6] },
    { in: [], elements: [8, 10] },
  ],
  steps: [
    ...ALL_REGIONS.map((region) => ({ explanation: `Only ${JSON.stringify(region)}.`, highlights: [{ in: region }] })),
    {
      explanation: "All three tones.",
      highlights: [{ in: ["a", "b"] }, { in: ["a", "b", "c"], tone: "done" }, { in: [], tone: "muted" }],
      variables: [{ name: "$|A \\cap B|$", value: 4 }],
    },
  ],
};
const many = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const crowdedVenn = {
  title: "Too many to fit",
  sets: [
    { id: "p", label: "A rather long set label here" },
    { id: "q", label: "Another long label for $Q$" },
    { id: "r", label: "And a third long set label" },
  ],
  universe: "Integers up to a lot",
  regions: [
    { in: ["p"], elements: many(100, 30) },
    { in: ["p", "q", "r"], elements: many(200, 30) },
    { in: ["q", "r"], count: 40, elements: [] },
    { in: [], elements: many(300, 30) },
  ],
};

const threeSets = [
  { id: "a", label: "$A$" },
  { id: "b", label: "$B$" },
  { id: "c", label: "$C$" },
];

/** Sol's review cases: contents that spill by size though they're short or schema-valid, and small examples that should stay put. */
const spillVenn = {
  title: "Contents that could spill",
  sets: threeSets,
  regions: [
    { in: ["a", "b"], elements: [], count: 1_000_000 },
    { in: ["a"], elements: ["a b c d e f g h i j k l"] },
    { in: ["b", "c"], elements: ["$\\frac{a+b+c+d}{e+f+g}$"] },
    { in: ["c"], elements: [1], count: 22 },
  ],
};
const smallVenn = {
  title: "A small example",
  sets: threeSets,
  regions: [
    { in: ["a", "b"], elements: [4, 5, 6] },
    { in: ["a"], elements: [1] },
    { in: ["b"], elements: [], count: 1 },
  ],
};
const repeatedVenn = {
  title: "Same words, different regions",
  sets: threeSets,
  regions: [],
  steps: [
    { explanation: "Look here.", highlights: [{ in: ["a"] }] },
    { explanation: "Look here.", highlights: [{ in: ["b"] }], variables: [{ name: "seen", value: 1 }] },
  ],
};

const oneSet = {
  title: "One set and its complement",
  sets: [{ id: "a", label: "$A$" }],
  universe: "$U$",
  regions: [
    { in: ["a"], elements: [1, 2, 3, 4], count: 12 },
    { in: [], elements: [], count: 1_000_000 },
  ],
};
const twoSets = {
  title: "Two sets",
  sets: [
    { id: "a", label: "Evens" },
    { id: "b", label: "Multiples of 3" },
  ],
  universe: "$U$",
  regions: [
    { in: ["a"], elements: many(100, 8) },
    { in: ["b"], elements: [3, 9, 15] },
    { in: ["a", "b"], elements: [6, 12, 18, 24] },
    { in: [], elements: [1, 5] },
  ],
};

type Step = { tool: string; input: unknown } | { text: string; hold?: boolean; stream?: boolean };

const STREAM_CHUNK_CHARS = 24;
const STREAM_CHUNK_DELAY_MS = 16;

/** About 14k characters of prose around `count` copies of `item`, in `paragraphs` paragraphs. */
function longReply(item: (i: number) => string, count: number, paragraphs: number) {
  const filler = "The window slides one place to the right and only the changed elements are recomputed. ";
  const perItem = Math.round(14_000 / count) - 8;
  const parts = Array.from({ length: count }, (_, i) => `${filler.repeat(Math.ceil(perItem / filler.length)).slice(0, perItem)}${item(i)}`);
  const perParagraph = Math.ceil(count / paragraphs);
  return Array.from({ length: paragraphs }, (_, p) => parts.slice(p * perParagraph, (p + 1) * perParagraph).join(" ")).join("\n\n");
}
const currency = (i: number) => `$${i + 5} `;
const formula = (i: number) => `$x_{${i}}^2$ `;

/**
 * Held steps wait for POST /e2e/release. A release that arrives first is remembered, because a test
 * can see the check before the model has reached the step after it.
 */
let waiting: (() => void) | undefined;
let released = false;
function releaseHeld() {
  if (waiting) waiting();
  else released = true;
  waiting = undefined;
}
function held() {
  if (released) {
    released = false;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => (waiting = resolve));
}

const longFormula = Array.from({ length: 40 }, (_, i) => `a_{${i}}`).join("");

const literalTrace = { ...trace, title: "Swap *demo* in $O(n^2)$", steps: [{ explanation: "Multiply 2*3*4 and compare with $x_1 + \\frac{a}{b}$, for $5 or $10." }] };
const literalCheck = {
  concept: "literal answers",
  question: "Which is *the* product, given $x^2$?",
  options: [{ text: "2*3*4" }, { text: "234" }, { text: "$2 \\times 3 \\times 4$" }],
  correctOptionIndex: 0,
  explanation: "2*3*4 is $24$, and 234 isn't.",
};

const graphTree = {
  title: "Inorder walk of a BST",
  directed: true,
  kind: "tree",
  nodes: ["8", "3", "10", "1", "6", "14", "13"].map((id) => ({ id })),
  edges: [["8", "3", "left"], ["8", "10", "right"], ["3", "1", "left"], ["3", "6", "right"], ["10", "14", "right"], ["14", "13", "left"]].map(([from, to, side]) => ({ from, to, side })),
  steps: [
    { explanation: "Go left from the root until there's no left child.", nodeStates: [{ id: "1" }], edgeStates: [{ from: "8", to: "3" }, { from: "3", to: "1" }] },
    { explanation: "Visit 1, then its parent.", nodeStates: [{ id: "1", tone: "done" }, { id: "3" }], variables: [{ name: "visited", value: "1" }] },
  ],
};
const graphWeighted = {
  title: "Dijkstra from $v_0$",
  directed: true,
  nodes: [{ id: "a", label: "$v_0$" }, { id: "b", label: "$v_1$" }, { id: "c", label: "$v_2$" }, { id: "d", label: "$v_3$" }, { id: "e", label: "goal" }],
  edges: [
    { from: "a", to: "b", weight: 4 },
    { from: "a", to: "c", weight: 1 },
    { from: "c", to: "b", weight: 2 },
    { from: "b", to: "c", weight: 7 },
    { from: "b", to: "d", weight: 5 },
    { from: "c", to: "d", weight: 8 },
    { from: "d", to: "e", label: "$x^2$" },
  ],
  steps: [
    { explanation: "Start at $v_0$ with distance $0$.", nodeStates: [{ id: "a" }], variables: [{ name: "dist(a)", value: 0 }] },
    { explanation: "Relax the edge to $v_2$.", nodeStates: [{ id: "a", tone: "done" }, { id: "c" }], edgeStates: [{ from: "a", to: "c" }, { from: "a", to: "b", tone: "muted" }] },
    { explanation: "Take the cheaper way to $v_1$.", nodeStates: [{ id: "c", tone: "done" }, { id: "b" }], edgeStates: [{ from: "c", to: "b", tone: "done" }] },
  ],
};
const graphLoop = {
  title: "A multigraph with loops",
  directed: false,
  nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
  edges: [
    { from: "A", to: "B", label: "p" },
    { from: "A", to: "B", label: "q" },
    { from: "A", to: "B", label: "r" },
    { from: "B", to: "C" },
    { from: "C", to: "C", label: "s" },
    { from: "A", to: "A" },
    { from: "A", to: "A" },
  ],
  steps: [{ explanation: "Follow the middle edge.", edgeStates: [{ from: "B", to: "A", nth: 1 }] }, { explanation: "Then the loop.", edgeStates: [{ from: "C", to: "C", tone: "done" }] }],
};
// At the schema's limits, which can't fit legibly at 320px.
const graphLimit = {
  title: "The largest graph allowed",
  directed: false,
  nodes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}` })),
  edges: Array.from({ length: 200 }, (_, i) => ({ from: `n${i % 60}`, to: `n${(i * 7 + 11) % 60}`, weight: i })),
};

// As deep as the schema allows, all to one side, and with steps so the keyboard has two jobs here.
const graphSkew = {
  title: "A degenerate BST",
  directed: true,
  kind: "tree",
  nodes: Array.from({ length: 60 }, (_, i) => ({ id: String(i) })),
  edges: Array.from({ length: 59 }, (_, i) => ({ from: String(i), to: String(i + 1), side: "right" })),
  steps: [{ explanation: "Every insert goes right.", nodeStates: [{ id: "0" }] }, { explanation: "So searching is linear.", nodeStates: [{ id: "1" }] }],
};

// A left subtree that runs right: inorder only reads across the page if 6, 7 and 8 stay left of the root.
const graphBst = {
  title: "A BST with a long left subtree",
  directed: true,
  kind: "tree",
  nodes: ["10", "5", "20", "6", "7", "8"].map((id) => ({ id })),
  edges: [["10", "5", "left", 5], ["10", "20", "right", 10], ["5", "6", "right", 1], ["6", "7", "right", 1], ["7", "8", "right", 1]].map(([from, to, side, weight]) => ({ from, to, side, weight })),
};

/** A sided tree with the longest labels the schema allows: same-level nodes and sibling edge labels are tightest here. */
const wideTree = (title: string, label: (i: number) => string) => ({
  title,
  directed: true,
  kind: "tree",
  nodes: ["r", "a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, label: label(i) })),
  edges: [["r", "a", "left"], ["r", "b", "right"], ["a", "c", "left"], ["a", "d", "right"], ["b", "e", "left"], ["b", "f", "right"]].map(([from, to, side], i) => ({ from, to, side, label: label(i + 7) })),
  steps: [{ explanation: "Start at the root.", nodeStates: [{ id: "r" }], edgeStates: [{ from: "r", to: "a" }] }, { explanation: "Then a child.", nodeStates: [{ id: "r", tone: "done" }, { id: "a" }] }],
});
const wideGeneral = (title: string, label: (i: number) => string) => ({
  title,
  directed: false,
  nodes: ["a", "b", "c", "d"].map((id, i) => ({ id, label: label(i) })),
  edges: [["a", "b"], ["b", "c"], ["c", "d"], ["d", "a"]].map(([from, to], i) => ({ from, to, label: label(i + 4) })),
  steps: [{ explanation: "Start here.", nodeStates: [{ id: "a" }] }, { explanation: "Follow the cycle.", nodeStates: [{ id: "b" }] }],
});
// 24 characters each, but far wider than that estimates.
const katexLabel = (i: number) => `$\\text{WWWWWWWWWWWWW${String.fromCharCode(65 + i)}W}$`;
const cjkLabel = (i: number) => `${"图论中的最短路径问题".repeat(2)}算法标${i}`.slice(0, 24);
// Taller than a node has room for, and one too wide even for a row of the list below the drawing.
const graphTall = { title: "Tall labels", directed: false, nodes: [{ id: "a", label: "$\\dfrac{a^{b^c}}{d_e}$" }, { id: "b" }, { id: "c", label: "$\\Huge\\text{WWWWWWWWWW}$" }], edges: [{ from: "a", to: "b", label: "$\\dfrac{a^2}{b^2}$" }, { from: "b", to: "c" }] };
// What a graph's labels normally look like. None of these may be cut short.
const shortFormulas = ["$a+b+c$", "$\\{1,2,3\\}$", "$f:A\\to B$", "$x+y$", "$v_0$", "$v_{10}$", "$A$", "$MN$", "$x^2$", "$\\alpha$", "$\\emptyset$", "$\\{a,b\\}$", "$f(x)$", "$A \\cup B$", "$p \\land q$", "$\\sqrt{2}$", "$\\mathbb{N}$", "$2^n$", "$\\frac{a}{b}$", "start", "12", "图论"];
const graphShort = {
  title: "Everyday labels",
  directed: true,
  nodes: shortFormulas.map((label, i) => ({ id: `n${i}`, label })),
  edges: shortFormulas.map((label, i) => ({ from: `n${i}`, to: `n${(i + 1) % shortFormulas.length}`, label })),
  steps: [{ explanation: "Visit a vertex.", nodeStates: [{ id: "n0" }] }, { explanation: "Follow an edge.", nodeStates: [{ id: "n1" }], edgeStates: [{ from: "n0", to: "n1" }] }],
};

// Long formulas in the title and an explanation, which arrow keys scroll while the card's arrow keys step.
const wideTitle = `$${Array.from({ length: 18 }, (_, i) => `a_{${i}}`).join("")}$`;
const graphWide = {
  title: wideTitle,
  directed: false,
  nodes: [{ id: "a" }, { id: "b" }],
  edges: [{ from: "a", to: "b" }],
  steps: [{ explanation: `Add $${longFormula}$ here.`, nodeStates: [{ id: "a" }] }, { explanation: "Then stop.", nodeStates: [{ id: "b" }] }],
};
const vennWide = {
  title: wideTitle,
  sets: [{ id: "a", label: "$A$" }],
  regions: [{ in: ["a"], elements: [1] }],
  steps: [{ explanation: `Add $${longFormula}$ here.`, highlights: [{ in: ["a"] }] }, { explanation: "Then stop." }],
};

const truthTable = {
  title: "Truth table for $p \\land q$",
  columns: ["$p$", "$q$", "$p \\land q$"],
  rows: [
    [true, true, ""],
    [true, false, ""],
    [false, true, ""],
    [false, false, ""],
  ],
  steps: [
    { explanation: "Both inputs are true.", highlight: [{ row: 0 }], cells: [{ row: 0, column: 2, value: true }] },
    { explanation: "One input is false.", highlight: [{ row: 1 }], cells: [{ row: 1, column: 2, value: false }] },
    { explanation: "The rest are false too.", highlight: [{ column: 2, tone: "done" as const }], cells: [{ row: 2, column: 2, value: false }, { row: 3, column: 2, value: false }] },
  ],
};
// The most columns the table schema allows, with wide content.
const wideTable = {
  title: "A wide relation matrix",
  columns: Array.from({ length: 16 }, (_, i) => `$x_{${i}} \\lor y_{${i}}$`),
  rowHeaders: ["$x$", "$y$"],
  rows: [Array.from({ length: 16 }, () => true), Array.from({ length: 16 }, () => longValue)],
};
const proof = {
  title: "Sum of the first $n$ integers",
  goal: "Show $\\sum_{i=1}^n i = n(n+1)/2$",
  steps: [
    { label: "Base case", statement: "$1 = 1(1+1)/2$", justification: "by direct calculation" },
    { label: "Inductive hypothesis", statement: "Assume $\\sum_{i=1}^k i = k(k+1)/2$", justification: "for some $k \\ge 1$" },
    { label: "Inductive step", statement: `$\\displaystyle \\sum_{i=1}^{k+1} i = \\frac{k(k+1)}{2} + k + 1 = \\frac{(k+1)(k+2)}{2}$`, justification: "by the inductive hypothesis" },
  ],
};

// A formula with no operators to break at is wider than a phone, next to short ones that fit.
const wideProof = {
  // Short enough for the title's limit, and still too wide for a phone.
  title: `$${Array.from({ length: 18 }, (_, i) => `a_{${i}}`).join("")}$`,
  steps: [
    { label: "Short", statement: "$x = x$", justification: "by reflexivity" },
    { label: "Long", statement: `$${longFormula}$`, justification: "by adding them up" },
    { label: "After", statement: "$y = y$", justification: "by reflexivity" },
  ],
};
const wideExplanationTable = {
  title: "Same words, new cells",
  columns: ["$a$", "$b$"],
  rows: [["", ""]],
  steps: [
    { explanation: "Fill in a cell.", cells: [{ row: 0, column: 0, value: 1 }] },
    { explanation: "Fill in a cell.", highlight: [{ column: 1 }], cells: [{ row: 0, column: 1, value: 2 }] },
    { explanation: `$${longFormula}$` },
  ],
};
const wideTitleTable = { title: wideProof.title, columns: ["$a$"], rows: [[1]] };

const wideFormula = "$\\displaystyle {\\sum_{i=1}^{n} i + \\sum_{j=1}^{m} j + \\sum_{k=1}^{p} k + \\sum_{l=1}^{q} l + \\sum_{r=1}^{s} r}$";
const wideFormulaTrace = {
  title: wideFormula,
  values: [1, 2],
  steps: [{ explanation: wideFormula }, { explanation: "Then this." }],
};

// Formulas with nowhere to break, in every place a stepped artifact can draw one. Chromium makes anything that overflows a tab stop.
const unbroken = (letter: string) => `$${letter.repeat(22)}$`;
const tabSet = {
  title: "Long labels",
  sets: [{ id: "a", label: unbroken("W") }, { id: "b", label: "$B$" }],
  universe: unbroken("U"),
  regions: [{ in: ["a"], elements: [unbroken("M")] }, { in: ["b"], elements: [2] }],
  steps: [
    { explanation: "Look at this one.", highlights: [{ in: ["a"] }], variables: [{ name: "x", value: unbroken("V") }] },
    { explanation: "Then stop." },
  ],
};
const tabGraph = {
  title: "Long labels",
  directed: false,
  nodes: [{ id: "a", label: unbroken("W") }, { id: "b" }],
  edges: [{ from: "a", to: "b", label: unbroken("M") }],
  steps: [{ explanation: "Look at this one.", nodeStates: [{ id: "a" }], variables: [{ name: "x", value: longValue.repeat(3) }] }, { explanation: "Then stop." }],
};
const tabTrace = {
  title: "Long values",
  values: [longValue, longValue, longValue],
  steps: [{ explanation: "Look at this one.", variables: [{ name: "x", value: longValue.repeat(3) }] }, { explanation: "Then stop." }],
};
const tabTable = {
  title: "Long cells",
  columns: [unbroken("W")],
  rows: [[unbroken("M")]],
  steps: [{ explanation: "Look at this one." }, { explanation: "Then stop." }],
};

const SCRIPTS: Record<string, Step[]> = {
  tabset: [{ tool: "show_set_diagram", input: tabSet }, { text: "Tab through the diagram." }],
  tabgraph: [{ tool: "show_graph", input: tabGraph }, { text: "Tab through the graph." }],
  tabtrace: [{ tool: "show_algorithm_trace", input: tabTrace }, { text: "Tab through the trace." }],
  tabtable: [{ tool: "show_table", input: tabTable }, { text: "Tab through the table." }],
  widegraph: [{ tool: "show_graph", input: graphWide }, { text: "Scroll the long graph." }],
  wideset: [{ tool: "show_set_diagram", input: vennWide }, { text: "Scroll the long diagram." }],
  widetrace: [{ tool: "show_algorithm_trace", input: wideFormulaTrace }, { text: "Scroll the long trace." }],
  graphcutkatex: [{ tool: "show_graph", input: wideTree("Wide formulas", katexLabel) }, { text: "Here are the wide formulas." }],
  graphcutcjk: [{ tool: "show_graph", input: wideTree("Wide characters", cjkLabel) }, { text: "Here are the wide characters." }],
  graphcutgeneral: [{ tool: "show_graph", input: wideGeneral("Wide formulas, no tree", katexLabel) }, { text: "Here's the wide graph." }],
  graphcutcjkgeneral: [{ tool: "show_graph", input: wideGeneral("Wide characters, no tree", cjkLabel) }, { text: "Here's the other wide graph." }],
  graphcuttall: [{ tool: "show_graph", input: graphTall }, { text: "Here are the tall labels." }],
  graphshort: [{ tool: "show_graph", input: graphShort }, { text: "Here are the everyday labels." }],
  graphbst: [{ tool: "show_graph", input: graphBst }, { text: "Here's the BST." }],
  graphskew: [{ tool: "show_graph", input: graphSkew }, { text: "Here's the skewed tree." }],
  graphtree: [{ tool: "show_graph", input: graphTree }, { text: "Here's the tree." }],
  graphweighted: [{ tool: "show_graph", input: graphWeighted }, { text: "Here's the graph." }],
  graphloop: [{ tool: "show_graph", input: graphLoop }, { text: "Here's the multigraph." }],
  graphlimit: [{ tool: "show_graph", input: graphLimit }, { text: "Here's the big one." }],
  wideproof: [
    { tool: "show_worked_steps", input: wideProof },
    { tool: "show_table", input: wideExplanationTable },
    { tool: "show_table", input: wideTitleTable },
    { text: "Scroll the long one." },
  ],
  truthtable: [
    { tool: "show_table", input: truthTable },
    { tool: "show_table", input: wideTable },
    { text: "Step through the table." },
  ],
  workedproof: [
    { tool: "show_worked_steps", input: proof },
    { text: "Reveal each step." },
  ],
  literals: [
    { tool: "show_algorithm_trace", input: literalTrace },
    { tool: "ask_multiple_choice", input: literalCheck },
    {
      text: `## Why it matters\n\nA **sum** like $\\sum_{i=1}^n i$ costs $5 and $10, see \`$x$\`.\n\n- one\n- two with [a link](https://example.com)\n\n$$\\left(${longFormula}\\right)$$\n\n| a | b |\n|---|---|\n| $x$ | \`y\` |\n\n\`\`\`js\nconst cost = "$5";\n\`\`\``,
    },
  ],
  // Too deep to parse in reasonable time, with a normal paragraph after it.
  deepnesting: [{ text: `${">".repeat(2000)} deep\n\n**still fine**`, stream: true }],
  // An inequality with many closed intervals, which is ordinary discrete maths.
  intervals: [{ text: `$a<b$ ${"$[0,1]$ ".repeat(66)}` }],
  teach: [
    { tool: "show_algorithm_trace", input: trace },
    { tool: "ask_multiple_choice", input: check },
    { text: "Step through it, then answer the check." },
  ],
  // Holds the reply open after the check, so a test can see it while it's still streaming.
  slow: [{ tool: "ask_multiple_choice", input: check }, { text: "Take your time.", hold: true }],
  maths: [
    {
      text: `This is **really bold**, with $x^2$ inline, and it costs $5 and $10.\n\n$$\\left(${longFormula}\\right)$$\n\nInline too: $\\left(${longFormula}\\right)$`,
    },
  ],
  // Long replies that arrive in many small deltas, like a real model's.
  currencyparagraph: [{ text: longReply(currency, 40, 1), stream: true }],
  currencyblocks: [{ text: longReply(currency, 40, 20), stream: true }],
  formulaparagraph: [{ text: longReply(formula, 100, 1), stream: true }],
  formulablocks: [{ text: longReply(formula, 100, 20), stream: true }],
  venn: [{ tool: "show_set_diagram", input: venn }, { text: "Step through the diagram." }],
  crowdedsets: [{ tool: "show_set_diagram", input: crowdedVenn }, { text: "A crowded diagram." }],
  oneset: [{ tool: "show_set_diagram", input: oneSet }, { text: "One set." }],
  twosets: [{ tool: "show_set_diagram", input: twoSets }, { text: "Two sets." }],
  spillsets: [{ tool: "show_set_diagram", input: spillVenn }, { text: "Contents that could spill." }],
  smallsets: [{ tool: "show_set_diagram", input: smallVenn }, { text: "A small example." }],
  repeatedsets: [{ tool: "show_set_diagram", input: repeatedVenn }, { text: "Same words." }],
  wide: [
    { tool: "show_algorithm_trace", input: wideTrace },
    { tool: "ask_multiple_choice", input: wideCheck },
    { text: `A long word in prose: ${longWord}${longWord}` },
  ],
};

interface PromptMessage {
  role: string;
  content: unknown;
}

function nextStep(prompt: PromptMessage[]): Step {
  const lastUser = prompt.findLastIndex((m) => m.role === "user");
  const text = JSON.stringify(prompt[lastUser]?.content);
  if (text.includes("fail")) throw new Error("PROVIDER-SECRET-DETAIL");
  const toolResults = prompt.slice(lastUser).filter((m) => m.role === "tool").length;
  // Asks a check on a concept named by the test, so its evidence is the test's own.
  const practise = /practise (\w+)/.exec(text)?.[1];
  if (practise) {
    return toolResults === 0 ? { tool: "ask_multiple_choice", input: { ...check, concept: practise } } : { text: "Answer it." };
  }
  // Saves a memory for a test to find in the panel.
  const note = /note (\w+)/.exec(text)?.[1];
  if (note) {
    return toolResults === 0 ? { tool: "remember", input: { kind: "goal", text: `Wants to learn ${note}` } } : { text: "Noted." };
  }
  // Reports whether the instructions mention a memory.
  const known = /known (\w+)/.exec(text)?.[1];
  if (known) return { text: JSON.stringify(prompt[0]?.content).includes(known) ? "Yes, I know that." : "No, I don't know that." };
  // Reports whether a document excerpt holding that word reached the model.
  const excerpt = /excerpt (\w+)/.exec(text)?.[1];
  if (excerpt) {
    const block = /<document_excerpts>[\s\S]*<\/document_excerpts>/.exec(JSON.stringify(prompt.slice(1)))?.[0] ?? "";
    return { text: block.includes(excerpt) ? `Excerpt reached me: ${excerpt}.` : "No excerpt reached me." };
  }
  // Reports what the instructions say about that concept from earlier sessions.
  const recall = /recall (\w+)/.exec(text)?.[1];
  if (recall) {
    const row = JSON.stringify(prompt[0]?.content).replaceAll("\\", "");
    const state = new RegExp(`"concept":"${recall}","attempts":(\\d+),"correct":(\\d+),"lastResult":"(\\w+)"`).exec(row);
    return { text: `Record: ${state ? `${state[1]} answered, ${state[2]} right, last ${state[3]}` : "nothing"}.` };
  }
  const script = Object.keys(SCRIPTS).find((name) => text.includes(name));
  if (script) {
    return SCRIPTS[script]![toolResults] ?? { text: "Done." };
  }
  // Anything else is a follow-up: report what the server told the model about the learner's answer.
  const result = /learnerResult\\*":\\*"([a-z ]+)/.exec(JSON.stringify(prompt))?.[1];
  return { text: `The server says the answer was: ${result ?? "unknown"}.` };
}

const model = new MockLanguageModelV4({
  doStream: async ({ prompt }) => {
    const step = nextStep(prompt as PromptMessage[]);
    const chunks: object[] =
      "tool" in step
        ? [
            { type: "tool-call" as const, toolCallId: crypto.randomUUID(), toolName: step.tool, input: JSON.stringify(step.input) },
            { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage },
          ]
        : [
            { type: "text-start" as const, id: "t" },
            ...("stream" in step && step.stream
              ? (step.text.match(new RegExp(`[\\s\\S]{1,${STREAM_CHUNK_CHARS}}`, "g")) ?? []).map((delta) => ({ type: "text-delta" as const, id: "t", delta }))
              : [{ type: "text-delta" as const, id: "t", delta: step.text }]),
            { type: "text-end" as const, id: "t" },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
          ];
    if ("hold" in step) await held();
    const chunkDelayInMs = "stream" in step && step.stream ? STREAM_CHUNK_DELAY_MS : null;
    return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs }) as never };
  },
});

const dataDir = mkdtempSync(join(tmpdir(), "mivra-e2e-"));
const token = loadOrCreateToken(dataDir);
const db = openDb(join(dataDir, "mivra.db"));
const app = createApp({
  db,
  model: () => model,
  security: { token, allowedHosts: [] },
});
// Lets a test finish a held reply once it has seen the state it wants to check.
app.post("/e2e/release", (c) => {
  releaseHeld();
  return c.body(null, 204);
});
serveWeb(app, fileURLToPath(new URL("../web/dist", import.meta.url)), token);

serve({ fetch: app.fetch, port: Number(process.argv[2]), hostname: "127.0.0.1" });

// Playwright stops this process with SIGTERM (gracefulShutdown in playwright.config.ts).
process.on("SIGTERM", () => {
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
});
