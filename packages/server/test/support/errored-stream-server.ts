import { serve } from "@hono/node-server";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createApp } from "../../src/app.js";
import { openDb } from "../../src/db/client.js";

// A real HTTP server in its own process: an unhandled rejection must kill this fixture, not Vitest.
const db = openDb(":memory:");
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
let call = 0;
let source: ReadableStreamDefaultController | undefined;
const model = new MockLanguageModelV4({
  doStream: async ({ abortSignal, prompt }) => {
    call++;
    if (process.argv[2] === "after-tool" && call === 1) {
      return { stream: simulateReadableStream({ chunks: [
        { type: "tool-call", toolCallId: "memory", toolName: "remember", input: JSON.stringify({ kind: "goal", text: "PRIVATE held memory" }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ] }) };
    }
    if (JSON.stringify(prompt.at(-1)).includes("recover")) {
      return { stream: simulateReadableStream({ chunks: [
        { type: "text-start", id: "ok" },
        { type: "text-delta", id: "ok", delta: "Recovered reply" },
        { type: "text-end", id: "ok" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] }) };
    }
    return { stream: new ReadableStream({
      start(controller) {
        source = controller;
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "Partial reply" });
        abortSignal?.addEventListener("abort", () => controller.error(new Error("provider closed on abort")), { once: true });
      },
    }) };
  },
});
process.on("message", () => source!.error(new APICallError({
  message: "Failed to process successful response",
  url: "https://invalid.test",
  requestBodyValues: { private: "PRIVATE request body" },
  cause: "Client connection prematurely closed.",
  statusCode: 200,
})));
const app = createApp({ db, model: () => model, security: { token: "t", allowedHosts: [] } });
serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => new URL(request.url).pathname === "/test-state"
    ? Response.json({ runs: db.$client.prepare("select status, error from runs order by rowid").all(), memories: db.$client.prepare("select status from memories").all() })
    : app.fetch(request),
}, (info) => process.send!({ port: info.port }));
