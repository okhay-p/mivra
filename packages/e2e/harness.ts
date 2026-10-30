import { mkdtempSync } from "node:fs";
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

type Step = { tool: string; input: unknown } | { text: string; delayMs?: number };

const SCRIPTS: Record<string, Step[]> = {
  teach: [
    { tool: "show_algorithm_trace", input: trace },
    { tool: "ask_multiple_choice", input: check },
    { text: "Step through it, then answer the check." },
  ],
  // Holds the reply open after the check, so a test can see it while it's still streaming.
  slow: [{ tool: "ask_multiple_choice", input: check }, { text: "Take your time.", delayMs: 3000 }],
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
  const script = Object.keys(SCRIPTS).find((name) => text.includes(name));
  if (script) {
    const toolResults = prompt.slice(lastUser).filter((m) => m.role === "tool").length;
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
            { type: "text-delta" as const, id: "t", delta: step.text },
            { type: "text-end" as const, id: "t" },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
          ];
    const delayMs = "delayMs" in step ? step.delayMs : undefined;
    return { stream: simulateReadableStream({ chunks, initialDelayInMs: delayMs ?? null }) as never };
  },
});

const dataDir = mkdtempSync(join(tmpdir(), "mivra-e2e-"));
const token = loadOrCreateToken(dataDir);
const app = createApp({
  db: openDb(join(dataDir, "mivra.db")),
  model: () => model,
  security: { token, allowedHosts: [] },
});
serveWeb(app as never, fileURLToPath(new URL("../web/dist", import.meta.url)), token);

serve({ fetch: app.fetch, port: Number(process.argv[2]), hostname: "127.0.0.1" });
