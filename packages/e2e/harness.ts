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

const SCRIPTS: Record<string, Step[]> = {
  wideproof: [
    { tool: "show_worked_steps", input: wideProof },
    { tool: "show_table", input: wideExplanationTable },
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
