import { ArtifactView } from "@mivra/protocol";
import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { artifacts, attempts, runs } from "../src/db/schema.js";
import { coreLearning } from "../src/plugins/core-learning.js";
import { createCapabilityRegistry, type Plugin } from "../src/runtime/capabilities.js";
import { deriveConceptState } from "../src/runtime/learner-context.js";
import { createTurnRunner } from "../src/runtime/turn-runner.js";
import { createSessionStore } from "../src/store/session-store.js";
import { fixedModel } from "./support/models.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const check = {
  concept: "binary search worst case",
  question: "Worst-case comparisons for binary search on 16 sorted items?",
  options: [{ text: "4", feedback: "SECRET-FEEDBACK: one short, you need to confirm the last item." }, { text: "5" }, { text: "16" }],
  correctOptionIndex: 1,
  explanation: "SECRET-EXPLANATION: 16, 8, 4, 2, 1 means five comparisons.",
};

const trace = {
  title: "Window of size 2",
  values: [1, 3, 2],
  steps: [{ explanation: "First window sums to 4.", ranges: [{ start: 0, end: 1 }], variables: [{ name: "sum", value: 4 }] }],
};

type Step =
  | { toolCall: { name: string; input: unknown } }
  | { text: string }
  | { stream: ReadableStream<object> }
  /** Raw provider stream parts, ending the step with a tool-calls finish. */
  | { raw: object[] }
  /** Starts a text reply that never finishes, until the request is aborted. */
  | { hang: true };

/** A model that plays scripted steps in order, one per model call, and records every prompt. */
function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const step = steps[call++] ?? { text: "ok" };
      if ("stream" in step) return { stream: step.stream as never };
      if ("hang" in step) {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue({ type: "text-start", id: "h" });
            c.enqueue({ type: "text-delta", id: "h", delta: "Let me explain" });
            abortSignal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
          },
        });
        return { stream: stream as never };
      }
      const chunks: object[] =
        "raw" in step
          ? [...step.raw, { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage }]
          : "toolCall" in step
          ? [
              { type: "tool-call" as const, toolCallId: `call_${call}`, toolName: step.toolCall.name, input: JSON.stringify(step.toolCall.input) },
              { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage },
            ]
          : [
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: step.text },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
}

function setup(steps: Step[], db: Db = openDb(":memory:")) {
  const model = scriptedModel(steps);
  const app = createApp({ db, model: () => model, security: { token: TOKEN, allowedHosts: [] } });
  return { app, db, model };
}
type App = ReturnType<typeof setup>["app"];

const userMessage = (text: string): UIMessage => ({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });

async function newSession(app: App) {
  return ((await (await app.request("/api/sessions", { method: "POST", headers: auth })).json()) as { id: string }).id;
}

async function turn(app: App, db: Db, sessionId: string, text: string) {
  const res = await app.request(`/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ message: userMessage(text) }),
  });
  expect(res.status).toBe(200);
  const sse = await res.text();
  await vi.waitFor(() =>
    expect(db.select().from(runs).where(eq(runs.sessionId, sessionId)).all().every((r) => r.status !== "running")).toBe(true),
  );
  return sse;
}

async function messagesJson(app: App, sessionId: string) {
  return (await app.request(`/api/sessions/${sessionId}/messages`, { headers: auth })).text();
}

function answer(app: App, artifactId: string, body: unknown) {
  return app.request(`/api/artifacts/${artifactId}/attempts`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SECRETS = ["correctOptionIndex", "SECRET-FEEDBACK", "SECRET-EXPLANATION"];

describe("multiple_choice through the agent", () => {
  it("never sends the answer key to the client, live or on reload", async () => {
    const { app, db, model } = setup([{ toolCall: { name: "ask_multiple_choice", input: check } }, { text: "Give it a try!" }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me on binary search");

    for (const secret of SECRETS) expect(sse).not.toContain(secret);
    expect(sse).toContain('"type":"data-artifact"');
    expect(sse).toContain(check.question);
    expect(sse).toContain("Give it a try!");
    expect(model.doStreamCalls).toHaveLength(2); // the tool loop continued after the call

    const reloaded = await messagesJson(app, sessionId);
    for (const secret of SECRETS) expect(reloaded).not.toContain(secret);
    expect(reloaded).toContain('"type":"data-artifact"');
    expect(reloaded).toContain(check.question);

    // The server keeps the full spec for grading and for the model's context.
    const [stored] = db.select().from(artifacts).all();
    expect(stored?.kind).toBe("multiple_choice");
    expect((stored?.spec as typeof check).correctOptionIndex).toBe(1);
  });

  it("grades an attempt once, revealing the answer only in the grade", async () => {
    const { app, db } = setup([{ toolCall: { name: "ask_multiple_choice", input: check } }, { text: "Try it." }]);
    const sessionId = await newSession(app);
    await turn(app, db, sessionId, "quiz me");
    const artifactId = db.select().from(artifacts).get()!.id;

    expect((await answer(app, artifactId, { answer: {} })).status).toBe(400);
    expect((await answer(app, artifactId, { answer: { optionIndex: 7 } })).status).toBe(400);

    const res = await answer(app, artifactId, { answer: { optionIndex: 0 } });
    expect(res.status).toBe(201);
    const view = (await res.json()) as { latestAttempt: { grade: { correct: boolean; correctOptionIndex: number; feedback?: string } } };
    expect(view.latestAttempt.grade).toMatchObject({ correct: false, correctOptionIndex: 1, feedback: check.options[0]!.feedback });

    expect((await answer(app, artifactId, { answer: { optionIndex: 1 } })).status).toBe(409);
    const [attempt] = db.select().from(attempts).all();
    expect(attempt).toMatchObject({ correct: false, concept: check.concept });

    // After answering, the reloaded view carries the grade.
    expect(await messagesJson(app, sessionId)).toContain('"latestAttempt"');
  });

  it("tells the model how the learner did on the next turn", async () => {
    const { app, db, model } = setup([
      { toolCall: { name: "ask_multiple_choice", input: check } },
      { text: "Try it." },
      { text: "Not quite." },
      { text: "Next." },
    ]);
    const sessionId = await newSession(app);
    await turn(app, db, sessionId, "quiz me");
    const artifactId = db.select().from(artifacts).get()!.id;

    await turn(app, db, sessionId, "thinking...");
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain("not answered yet");

    await answer(app, artifactId, { answer: { optionIndex: 2 } });
    await turn(app, db, sessionId, "I answered");
    const prompt = JSON.stringify(model.doStreamCalls[3]?.prompt);
    expect(prompt).toContain("incorrect");
    expect(prompt).toContain('"learnerResult":"incorrect","learnerChose":{"optionIndex":2,"text":"16"}');
  });

  it("tells a new session what the learner practised in earlier ones, without the answer key", async () => {
    const { app, db, model } = setup([
      { text: "Before any evidence." },
      { toolCall: { name: "ask_multiple_choice", input: check } },
      { text: "Try it." },
      { text: "Continue the lesson." },
      { text: "Welcome back." },
    ]);
    const first = await newSession(app);
    await turn(app, db, first, "hello");
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("learner_concepts");

    await turn(app, db, first, "quiz me");
    await answer(app, db.select().from(artifacts).get()!.id, { answer: { optionIndex: 2 } });

    await vi.waitFor(() => expect(db.select().from(runs).where(eq(runs.sessionId, first)).all().every(r => r.status !== "running")).toBe(true));
    const sse = await turn(app, db, await newSession(app), "what should I work on?");
    const prompt = JSON.stringify(model.doStreamCalls[4]?.prompt);
    expect(prompt).toContain("binary search worst case");
    expect(prompt).toContain('\\"attempts\\":1,\\"correct\\":0,\\"lastResult\\":\\"incorrect\\"');
    // The new session's own messages carry no trace of the old conversation.
    expect(prompt).not.toContain("quiz me");
    expect(prompt).not.toContain("SECRET");
    expect(sse).not.toContain("binary search worst case");
  });

  it("takes the latest result from insertion order when timestamps tie, and limits the evidence", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 31), toFake: ["Date"] });
    try {
      const db = openDb(":memory:");
      const store = createSessionStore(db);
      const session = store.createSession();
      const runId = store.startRun(session, userMessage("hi"));
      const record = (correct: boolean, toolCallId: string) => {
        const artifact = store.createArtifact({ sessionId: session.id, runId, toolCallId, kind: "multiple_choice", version: 1, spec: check });
        store.createAttempt({ artifactId: artifact.id, sessionId: session.id, answer: {}, grade: {}, correct, concept: "ties" });
      };
      record(false, "a");
      record(true, "b");
      record(false, "c");
      record(true, "d");

      expect(deriveConceptState(store.listRecentEvidence(1000))).toMatchObject([{ attempts: 4, correct: 2, lastResult: "correct" }]);
      // Beyond the window, older attempts stop counting.
      expect(deriveConceptState(store.listRecentEvidence(3))).toMatchObject([{ attempts: 3, correct: 2, lastResult: "correct" }]);

      // The index happens to return ties in this order; without it, only the explicit tie-breaker does.
      db.run(sql`DROP INDEX attempts_created_idx`);
      expect(deriveConceptState(store.listRecentEvidence(1000))).toMatchObject([{ lastResult: "correct" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the run if the learner's record can't be read", async () => {
    const db = openDb(":memory:");
    const store = createSessionStore(db);
    const session = store.createSession();
    const broken = { ...store, listRecentEvidence: () => { throw new Error("disk error"); } };
    const runner = createTurnRunner({ models: fixedModel, store: broken, registry: createCapabilityRegistry([coreLearning]), model: () => scriptedModel([]) });

    const result = await runner.startTurn({ sessionId: session.id, message: userMessage("hi") });
    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable", message: "Couldn't start the reply." } });
    expect(db.select().from(runs).get()).toMatchObject({ status: "failed", error: expect.stringContaining("disk error") });
  });

  it("rejects attempts on unknown artifacts, non-checks and discarded checks", async () => {
    const { app, db } = setup([{ toolCall: { name: "show_algorithm_trace", input: trace } }, { text: "Step through it." }]);
    const sessionId = await newSession(app);
    await turn(app, db, sessionId, "show me");
    const traceId = db.select().from(artifacts).get()!.id;

    expect((await answer(app, "missing", { answer: { optionIndex: 0 } })).status).toBe(404);
    expect((await answer(app, traceId, { answer: { optionIndex: 0 } })).status).toBe(400);

    // A check whose reply was cancelled is discarded.
    const store = createSessionStore(db);
    const session = store.findSession(sessionId)!;
    const runId = store.startRun(session, userMessage("again"));
    const discarded = store.createArtifact({ sessionId, runId, toolCallId: "c9", kind: "multiple_choice", version: 1, spec: check });
    store.finishRun(runId, sessionId, "cancelled");
    expect((await answer(app, discarded.id, { answer: { optionIndex: 1 } })).status).toBe(409);
  });
});

describe("fail-closed client output", () => {
  const leakyReasoning = [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "I'll set correctOptionIndex to 1. SECRET-EXPLANATION: halving." },
    { type: "reasoning-end", id: "r" },
  ];

  it("passes reasoning text without provider details or tool inputs, live and on reload", async () => {
    const { app, db, model } = setup([
      { raw: [
        ...leakyReasoning.map((chunk) => ({ ...chunk, providerMetadata: { vendor: { encrypted: "ENCRYPTED-SECRET" } } })),
        { type: "reasoning-start", id: "unsigned" },
        { type: "reasoning-delta", id: "unsigned", delta: "UNSIGNED-THINKING" },
        { type: "reasoning-end", id: "unsigned" },
        { type: "tool-call", toolCallId: "c1", toolName: "ask_multiple_choice", input: JSON.stringify(check) },
      ] },
      { text: "Try it." },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me");
    const reloaded = await messagesJson(app, sessionId);
    for (const body of [sse, reloaded]) {
      expect(body).toContain("I'll set correctOptionIndex to 1.");
      expect(body).toContain("UNSIGNED-THINKING");
      expect(body).not.toContain("ENCRYPTED-SECRET");
      expect(body).not.toContain("providerMetadata");
      expect(body).not.toContain("SECRET-FEEDBACK");
      expect(body).not.toContain('"correctOptionIndex":1');
      expect(body).not.toContain("tool-input");
    }
    expect(sse).toContain('"type":"data-artifact"');
    await turn(app, db, sessionId, "continue");
    const replay = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(replay).toContain("ENCRYPTED-SECRET"); // Provider-bound details stay intact for replay.
    expect(replay).not.toContain("UNSIGNED-THINKING"); // Plain thinking needn't bloat future context.
  });

  it("hides streamed tool-input fragments", async () => {
    const json = JSON.stringify(check);
    const { app, db } = setup([
      {
        raw: [
          { type: "tool-input-start", id: "c1", toolName: "ask_multiple_choice" },
          { type: "tool-input-delta", id: "c1", delta: json.slice(0, 60) },
          { type: "tool-input-delta", id: "c1", delta: json.slice(60) },
          { type: "tool-input-end", id: "c1" },
          { type: "tool-call", toolCallId: "c1", toolName: "ask_multiple_choice", input: json },
        ],
      },
      { text: "Try it." },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me");
    for (const secret of SECRETS) expect(sse).not.toContain(secret);
    expect(sse).not.toContain("tool-input");
    expect(sse).toContain('"type":"data-artifact"');
  });

  it("drops stored artifact tool calls when their plugin is no longer loaded", async () => {
    const db = openDb(":memory:");
    const first = setup([{ toolCall: { name: "ask_multiple_choice", input: check } }, { text: "Try it." }], db);
    const sessionId = await newSession(first.app);
    await turn(first.app, db, sessionId, "quiz me");

    const withoutPlugin = createApp({ db, model: () => scriptedModel([]), security: { token: TOKEN, allowedHosts: [] }, plugins: [] });
    const reloaded = await messagesJson(withoutPlugin, sessionId);
    for (const secret of SECRETS) expect(reloaded).not.toContain(secret);
    expect(reloaded).not.toContain("ask_multiple_choice");
    expect(reloaded).toContain("Try it.");
  });
});

describe("fail-closed client output: errors and metadata", () => {
  it("doesn't forward provider error text, which could echo a check's input", async () => {
    const { app, db } = setup([
      { toolCall: { name: "ask_multiple_choice", input: check } },
      { raw: [{ type: "error", error: new Error(`provider choked on ${JSON.stringify(check)}`) }] },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me");
    for (const secret of SECRETS) expect(sse).not.toContain(secret);
    expect(sse).toContain('"errorText":"The model request failed."');
    // Full detail is kept server-side for debugging.
    expect(db.select().from(runs).get()?.error).toContain("SECRET-EXPLANATION");
  });

  it("strips provider metadata from text, live and on reload", async () => {
    const meta = { vendor: { echo: check } };
    const { app, db } = setup([
      { toolCall: { name: "ask_multiple_choice", input: check } },
      {
        raw: [
          { type: "text-start", id: "t", providerMetadata: meta },
          { type: "text-delta", id: "t", delta: "Try it.", providerMetadata: meta },
          { type: "text-end", id: "t", providerMetadata: meta },
        ],
      },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me");
    const reloaded = await messagesJson(app, sessionId);
    for (const body of [sse, reloaded]) {
      for (const secret of SECRETS) expect(body).not.toContain(secret);
      expect(body).not.toContain("providerMetadata");
      expect(body).toContain("Try it.");
    }
  });

  it("replaces provider-controlled text ids and invalid finish reasons", async () => {
    const leakyId = "SECRET-EXPLANATION-as-id";
    const { app, db } = setup([
      { toolCall: { name: "ask_multiple_choice", input: check } },
      {
        raw: [
          { type: "text-start", id: leakyId },
          { type: "text-delta", id: leakyId, delta: "Try " },
          { type: "text-delta", id: leakyId, delta: "it." },
          { type: "text-end", id: leakyId },
          // The tool-calls finish appended by the script is valid; add a final step with a bad reason.
        ],
      },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me");
    expect(sse).not.toContain("SECRET-EXPLANATION");
    const ids = [...sse.matchAll(/"type":"text-(?:start|delta|end)","id":"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids)).toEqual(new Set(["text-1"])); // remapped, and consistent within the part

    const badFinish = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "SECRET-EXPLANATION", raw: "x" }, usage },
          ],
        }) as never,
      }),
    });
    const app2 = createApp({ db: openDb(":memory:"), model: () => badFinish, security: { token: TOKEN, allowedHosts: [] } });
    const session2 = await newSession(app2);
    const res = await app2.request(`/api/sessions/${session2}/chat`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ message: userMessage("hi") }),
    });
    expect(await res.text()).not.toContain("SECRET-EXPLANATION");
  });

  it("shows server-owned messages for configuration errors", async () => {
    const { LoadAPIKeyError, APICallError } = await import("ai");
    const failWith = (error: Error) =>
      createApp({
        db: openDb(":memory:"),
        model: () => {
          throw error;
        },
        security: { token: TOKEN, allowedHosts: [] },
      });
    const send = async (app: App) => {
      const sessionId = await newSession(app);
      const res = await app.request(`/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ message: userMessage("hi") }),
      });
      return ((await res.json()) as { error: string }).error;
    };
    // Server-owned messages: even a configuration error's own text isn't forwarded.
    expect(await send(failWith(new LoadAPIKeyError({ message: `missing key; ${JSON.stringify(check)}` })))).toBe(
      "The model provider's API key is missing. Set it in .env (see .env.example) and restart the server.",
    );
    const { NoSuchModelError } = await import("ai");
    expect(await send(failWith(new NoSuchModelError({ modelId: "x", modelType: "languageModel", message: JSON.stringify(check) })))).toBe(
      "Unknown model or provider. Choose another model in the picker under the message box.",
    );
    const outOfCredits = new APICallError({
      message: `echoes ${JSON.stringify(check)}`,
      url: "https://example.test",
      requestBodyValues: check,
      statusCode: 402,
    });
    expect(await send(failWith(outOfCredits))).toBe("The model request failed: the provider account is out of credits.");
  });
});

describe("run lifecycle and checks", () => {
  it("refuses an attempt while the reply that asked it is still running", async () => {
    const db = openDb(":memory:");
    const { app } = setup([], db);
    const store = createSessionStore(db);
    const session = store.createSession();
    const runId = store.startRun(session, userMessage("quiz me"));
    const artifact = store.createArtifact({ sessionId: session.id, runId, toolCallId: "c1", kind: "multiple_choice", version: 1, spec: check });

    const res = await answer(app, artifact.id, { answer: { optionIndex: 1 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The reply is still in progress; answer once it finishes" });
    expect(db.select().from(attempts).all()).toEqual([]);
  });

  it("discards a check whose reply is cancelled after the check was shown", async () => {
    const { app, db } = setup([{ toolCall: { name: "ask_multiple_choice", input: check } }, { hang: true }]);
    const sessionId = await newSession(app);
    const abort = new AbortController();
    const res = await app.request(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ message: userMessage("quiz me") }),
      signal: abort.signal,
    });
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("Let me explain")) seen += new TextDecoder().decode((await reader.read()).value);
    expect(seen).toContain('"type":"data-artifact"');
    abort.abort();
    await reader.cancel().catch(() => {});

    await vi.waitFor(() => expect(db.select().from(runs).get()?.status).toBe("cancelled"));
    const artifactId = db.select().from(artifacts).get()!.id;
    expect((await answer(app, artifactId, { answer: { optionIndex: 1 } })).status).toBe(409);
    expect(await messagesJson(app, sessionId)).not.toContain("data-artifact");
  });

  it("releases the run when a plugin's tool factory throws", async () => {
    const broken: Plugin = {
      name: "broken",
      capabilities: ["tools"],
      setup: (api) =>
        api.registerTool("explode", () => {
          throw new Error("tool setup failed");
        }),
    };
    const db = openDb(":memory:");
    const app = createApp({ db, model: () => scriptedModel([]), security: { token: TOKEN, allowedHosts: [] }, plugins: [coreLearning, broken] });
    const sessionId = await newSession(app);
    const send = () =>
      app.request(`/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ message: userMessage("hi") }),
      });

    const first = await send();
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "Couldn't start the reply." });
    expect(db.select().from(runs).get()).toMatchObject({ status: "failed", error: "tool setup failed" });
    expect((await send()).status).toBe(500); // not 409: the session isn't stuck
  });
});

describe("graph through the agent", () => {
  const graph = {
    title: "BFS from a",
    directed: true,
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b", weight: 3 }],
    steps: [{ explanation: "Start at a.", nodeStates: [{ id: "a" }], edgeStates: [{ from: "a", to: "b" }] }],
  };

  it("streams a strict view and stores the artifact", async () => {
    const { app, db } = setup([{ toolCall: { name: "show_graph", input: graph } }, { text: "Follow along." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "show me BFS");
    expect(sse).toContain('"kind":"graph"');
    expect(sse).toContain("BFS from a");
    expect(sse).toContain("Follow along.");
    const part = sse.split("\n").flatMap((line: string) => {
      if (!line.startsWith("data: {")) return [];
      const event = JSON.parse(line.slice(6));
      return event.type === "data-artifact" ? [event.data] : [];
    })[0];
    expect(ArtifactView.parse(part)).toMatchObject({ kind: "graph", version: 1, spec: graph });
    expect(db.select().from(artifacts).all()[0]).toMatchObject({ kind: "graph", version: 1 });
  });

  it("doesn't store a graph with a dangling edge", async () => {
    const bad = { ...graph, edges: [{ from: "a", to: "nope" }], steps: undefined };
    const { app, db } = setup([{ toolCall: { name: "show_graph", input: bad } }, { text: "Oops." }]);
    const sessionId = await newSession(app);
    await turn(app, db, sessionId, "show me");
    expect(db.select().from(artifacts).all()).toHaveLength(0);
  });
});

describe("algorithm_trace through the agent", () => {
  it("streams and reloads the full trace view", async () => {
    const { app, db } = setup([{ toolCall: { name: "show_algorithm_trace", input: trace } }, { text: "Step through it." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "show me a sliding window");
    expect(sse).toContain('"kind":"algorithm_trace"');
    expect(sse).toContain("First window sums to 4.");
    expect(await messagesJson(app, sessionId)).toContain("First window sums to 4.");
  });
});

const walkthrough = {
  title: "A click on Counter",
  code: {
    language: "JSX",
    source: "function Counter() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;\n}",
  },
  steps: [
    { label: "Initial render", explanation: "count starts at 0.", lines: [2, 3], variables: [{ name: "render.count", value: 0 }], output: "Count: 0" },
    { label: "Click handler", explanation: "The handler still sees 0 and queues 1.", lines: [3], variables: [{ name: "handler.count", value: 0 }, { name: "queued update", value: "count + 1" }], output: "Count: 0" },
    { label: "Render 2", explanation: "The next render reads 1.", lines: [2, 3], variables: [{ name: "render.count", value: 1 }], output: "Count: 1" },
  ],
};

const artifactParts = (messagesText: string) =>
  (JSON.parse(messagesText) as UIMessage[]).flatMap((m) => m.parts).flatMap((p) => (p.type === "data-artifact" ? [ArtifactView.parse((p as { data: unknown }).data)] : []));

describe("code_walkthrough through the agent", () => {
  it("streams, stores and reloads the full view, without the raw tool call", async () => {
    const { app, db, model } = setup([{ toolCall: { name: "show_code_walkthrough", input: walkthrough } }, { text: "Step through it." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "how does a React counter update?");
    expect(sse).toContain('"kind":"code_walkthrough"');
    expect(sse).not.toContain("show_code_walkthrough");
    expect(db.select().from(artifacts).get()).toMatchObject({ kind: "code_walkthrough", version: 1, spec: walkthrough });
    expect(artifactParts(await messagesJson(app, sessionId))).toEqual([expect.objectContaining({ kind: "code_walkthrough", version: 1, spec: walkthrough })]);
    const described = Object.fromEntries((model.doStreamCalls[0]!.tools ?? []).map((t) => [t.name, "description" in t ? t.description : ""]));
    expect(described.show_code_walkthrough).toMatch(/isn't about a sequence/);
  });

  it("is explanatory only: it can't be answered and records no attempt or evidence", async () => {
    const { app, db } = setup([{ toolCall: { name: "show_code_walkthrough", input: walkthrough } }, { text: "Step through it." }]);
    const sessionId = await newSession(app);
    await turn(app, db, sessionId, "show me");
    const res = await answer(app, db.select().from(artifacts).get()!.id, { answer: { optionIndex: 0 } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.select().from(attempts).all()).toEqual([]);
    expect(db.select().from(runs).all()).toHaveLength(1); // No continuation either.
  });

  it("stores nothing for a step highlighting a line outside the code", async () => {
    const bad = { ...walkthrough, steps: [{ ...walkthrough.steps[0]!, lines: [9] }] };
    const { app, db } = setup([{ toolCall: { name: "show_code_walkthrough", input: bad } }, { text: "Let me fix that." }]);
    const sse = await turn(app, db, await newSession(app), "show me");
    expect(db.select().from(artifacts).all()).toEqual([]);
    expect(sse).not.toContain("data-artifact");
  });
});

describe("prediction before walkthrough (#99)", () => {
  const snippet = "```jsx\nfunction Counter() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;\n}\n```";
  const prediction = {
    concept: "React state updates",
    question: "After one click, what does the button show?",
    options: [{ text: "Count: 0", feedback: "SECRET-FEEDBACK: the click queues a re-render." }, { text: "Count: 1" }, { text: "Count: 2" }],
    correctOptionIndex: 1,
    explanation: "SECRET-EXPLANATION: the next render reads count as 1.",
  };

  it("asks first, then explains the same snippet with a walkthrough once the graded result comes back", async () => {
    const { app, db, model } = setup([
      {
        raw: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: `Here's a counter:\n\n${snippet}\n\nWhat do you predict?` },
          { type: "text-end", id: "t" },
          { type: "tool-call", toolCallId: "predict", toolName: "ask_multiple_choice", input: JSON.stringify(prediction) },
        ],
      },
      { text: "" },
      {
        raw: [
          { type: "text-start", id: "u" },
          { type: "text-delta", id: "u", delta: "Not quite: here's how it runs." },
          { type: "text-end", id: "u" },
          { type: "tool-call", toolCallId: "walk", toolName: "show_code_walkthrough", input: JSON.stringify(walkthrough) },
        ],
      },
      { text: "Step through it." },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "teach me useState");

    // The instructions give the prediction exception to teach-then-check and say what follows the answer.
    const system = JSON.stringify(model.doStreamCalls[0]!.prompt.filter((m) => m.role === "system"));
    expect(system).toContain("Code prediction is the one exception to teaching before you check");
    expect(system).toContain("explain the same snippet with show_code_walkthrough");

    // The first completed reply: the snippet and an unanswered check, no walkthrough and no answer key.
    expect(sse).toContain("const [count, setCount] = useState(0);");
    for (const secret of SECRETS) expect(sse).not.toContain(secret);
    let views = artifactParts(await messagesJson(app, sessionId));
    expect(views.map((v) => v.kind)).toEqual(["multiple_choice"]);
    expect(views[0]).not.toHaveProperty("latestAttempt");
    for (const secret of SECRETS) expect(JSON.stringify(views)).not.toContain(secret);

    const check = db.select().from(artifacts).get()!;
    const res = await answer(app, check.id, { answer: { optionIndex: 0 } });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).toContain("SECRET-FEEDBACK");
    await vi.waitFor(() => expect(db.select().from(runs).all().map((r) => r.status)).toEqual(["completed", "completed"]));

    // The continuation sees the recorded result, then shows the walkthrough.
    const continued = JSON.stringify(model.doStreamCalls[2]!.prompt);
    expect(continued).toContain("all checks in the preceding reply have been answered");
    expect(continued).toContain('"learnerResult":"incorrect","learnerChose":{"optionIndex":0,"text":"Count: 0"}');
    expect(db.select().from(attempts).all()).toEqual([expect.objectContaining({ correct: false, concept: prediction.concept })]);

    // Reload keeps the graded check and the walkthrough, in order.
    views = artifactParts(await messagesJson(app, sessionId));
    expect(views.map((v) => v.kind)).toEqual(["multiple_choice", "code_walkthrough"]);
    expect(views[0]).toHaveProperty("latestAttempt.grade.correct", false);

    // A second answer is refused, so no second follow-up runs.
    expect((await answer(app, check.id, { answer: { optionIndex: 1 } })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 50));
    expect(db.select().from(runs).all()).toHaveLength(2);
    expect(db.select().from(artifacts).all().filter((a) => a.kind === "code_walkthrough")).toHaveLength(1);
  });
});

describe("set_diagram through the agent", () => {
  const diagram = {
    title: "Overlap",
    sets: [
      { id: "a", label: "$A$" },
      { id: "b", label: "$B$" },
    ],
    regions: [{ in: ["b", "a"], elements: [3, 5] }],
    steps: [{ explanation: "These are in both.", highlights: [{ in: ["a", "b"] }] }],
  };

  it("streams and reloads a view that passes the strict ArtifactView", async () => {
    const { app, db } = setup([{ toolCall: { name: "show_set_diagram", input: diagram } }, { text: "Step through it." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "show me an intersection");
    expect(sse).toContain('"kind":"set_diagram"');
    expect(sse).toContain("These are in both.");
    const messages = JSON.parse(await messagesJson(app, sessionId)) as { parts: { type: string; data?: unknown }[] }[];
    const part = messages.flatMap((m) => m.parts).find((p) => p.type === "data-artifact");
    const view = ArtifactView.parse(part?.data);
    expect(view).toMatchObject({ kind: "set_diagram", version: 1, spec: diagram });
    expect(db.select().from(artifacts).get()).toMatchObject({ kind: "set_diagram" });
  });

  it("stores nothing for a diagram that fails its rules", async () => {
    const bad = { ...diagram, regions: [{ in: ["z"], elements: [] }] };
    const { app, db } = setup([{ toolCall: { name: "show_set_diagram", input: bad } }, { text: "Let me fix that." }]);
    const sse = await turn(app, db, await newSession(app), "show me an intersection");
    expect(db.select().from(artifacts).all()).toEqual([]);
    expect(sse).not.toContain("data-artifact");
  });
});

describe("table and worked_steps through the agent", () => {
  const table = {
    title: "Truth table",
    columns: ["p", "not p"],
    rows: [[true, ""], [false, ""]],
    steps: [{ explanation: "Negate the first row.", highlight: [{ row: 0 }], cells: [{ row: 0, column: 1, value: false }] }],
  };
  const worked = {
    title: "A small proof",
    goal: "Show $1 + 1 = 2$",
    steps: [{ label: "Only step", statement: "$1 + 1 = 2$", justification: "by the definition of 2" }],
  };

  it.each([
    ["show_table", "table", table],
    ["show_worked_steps", "worked_steps", worked],
  ])("%s stores the spec and streams and reloads a view that passes the strict schema", async (tool, kind, spec) => {
    const { app, db } = setup([{ toolCall: { name: tool, input: spec } }, { text: "Have a look." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "show me");
    expect(sse).toContain(`"kind":"${kind}"`);
    expect(sse).not.toContain(tool); // Raw tool calls never reach a client.
    expect(db.select().from(artifacts).get()).toMatchObject({ kind, version: 1, spec });

    const messages = JSON.parse(await messagesJson(app, sessionId)) as { messages: UIMessage[] } | UIMessage[];
    const list = Array.isArray(messages) ? messages : messages.messages;
    const part = list.flatMap((m) => m.parts).find((p) => p.type === "data-artifact") as { data: unknown };
    expect(ArtifactView.parse(part.data)).toMatchObject({ kind, version: 1, spec });
    expect(await messagesJson(app, sessionId)).not.toContain(tool);
  });

  it("stores nothing for a table whose rows don't match its columns", async () => {
    const { app, db } = setup([{ toolCall: { name: "show_table", input: { ...table, rows: [[true]] } } }, { text: "Let me fix that." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "show me");
    expect(db.select().from(artifacts).all()).toEqual([]);
    expect(sse).not.toContain("data-artifact");
  });

  it("offers both tools to the model and tells it when to use them", async () => {
    const { app, db, model } = setup([{ text: "Hello." }]);
    await turn(app, db, await newSession(app), "hi");
    const { tools, prompt } = model.doStreamCalls[0]!;
    const described = Object.fromEntries((tools ?? []).map((t) => [t.name, "description" in t ? t.description : ""]));
    expect(described.show_table).toMatch(/truth table/i);
    expect(described.show_table).toMatch(/relation matri/i);
    expect(described.show_worked_steps).toMatch(/proof/i);
    expect(JSON.stringify(prompt)).toContain("show_worked_steps for proofs");
  });
});

describe("invalid tool input", () => {
  it("returns bare LaTeX to the model for repair without showing or storing a broken card", async () => {
    const bare = String.raw`\displaystyle\sum_{i=1}^{n} i`;
    const proof = { title: "Sum", steps: [{ statement: bare, justification: "Add the terms." }] };
    const corrected = { ...proof, steps: [{ ...proof.steps[0], statement: `$${bare}$` }] };
    const { app, db, model } = setup([
      { toolCall: { name: "show_worked_steps", input: proof } },
      { toolCall: { name: "show_worked_steps", input: corrected } },
      { text: "Read the working inline in the chat." },
    ]);
    const id = await newSession(app);
    const sse = await turn(app, db, id, "show a proof");
    expect(db.select().from(artifacts).all()).toHaveLength(1);
    expect(sse.match(/"type":"data-artifact"/g)).toHaveLength(1);
    const retry = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(retry).toContain("error");
    expect(retry).toContain("Wrap LaTeX commands");
    expect(retry).toContain(JSON.stringify(`$${bare}$`).slice(1, -1));
    expect(db.select().from(runs).all()[0]?.status).toBe("completed");
    const reload = await messagesJson(app, id);
    expect(reload.match(/"type":"data-artifact"/g)).toHaveLength(1);
  });

  it("fails visibly after five invalid proofs, but accepts turns that produced text or an artifact", async () => {
    const input = { title: "Sum", steps: [{ statement: String.raw`\displaystyle\sum_i i`, justification: "Add." }] };
    const invalid = { toolCall: { name: "show_worked_steps", input } };
    const corrected = { ...input, steps: [{ statement: "$1+2=3$", justification: "Add." }] };
    for (const last of [invalid, { text: "Let me rephrase." }, { toolCall: { name: "show_worked_steps", input: corrected } }]) {
      const { app, db, model } = setup([...Array.from({ length: 4 }, () => invalid), last]);
      const id = await newSession(app);
      const sse = await turn(app, db, id, "show a proof");
      const failed = last === invalid;
      expect(model.doStreamCalls).toHaveLength(5);
      expect(db.select().from(artifacts).all()).toHaveLength(last !== invalid && "toolCall" in last ? 1 : 0);
      expect(sse.includes('"type":"error"')).toBe(failed);
      if (failed) expect(sse).toContain('"errorText":"The model request failed."');
      expect(db.select().from(runs).all()[0]?.status).toBe(failed ? "failed" : "completed");
      const reloaded = JSON.parse(await messagesJson(app, id)) as UIMessage[];
      expect(reloaded.map((message) => message.role)).toEqual(failed ? ["user"] : ["user", "assistant"]);
    }
  });

  it("stores nothing and shows nothing for an empty or malformed artifact call", async () => {
    const { app, db } = setup([{ toolCall: { name: "ask_multiple_choice", input: {} } }, { text: "Let me rephrase." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me");
    expect(db.select().from(artifacts).all()).toEqual([]);
    expect(sse).not.toContain("ask_multiple_choice");
    expect(sse).not.toContain("data-artifact");
    expect(sse).toContain("Let me rephrase.");
    const reloaded = await messagesJson(app, sessionId);
    expect(reloaded).not.toContain("ask_multiple_choice");
  });
});

describe("capability registry", () => {
  it("still presents legacy stored proofs containing bare LaTeX", () => {
    const registry = createCapabilityRegistry([coreLearning]);
    const definition = registry.artifactKind("worked_steps")!;
    const spec = { title: "Old proof", steps: [{ statement: String.raw`\sum_i i`, justification: "Add." }] };
    const view = registry.viewOf(definition, { id: "old-proof", createdAt: new Date(0), spec });
    expect(view.spec).toEqual(spec);
  });

  it("refuses capabilities a plugin did not declare", () => {
    const sneaky: Plugin = { name: "sneaky", capabilities: [], setup: (api) => api.registerTool("x", () => ({}) as never) };
    expect(() => createCapabilityRegistry([sneaky])).toThrow(/did not declare the "tools" capability/);
  });

  it("refuses a tool name that is already taken", () => {
    const clash: Plugin = { name: "clash", capabilities: ["tools"], setup: (api) => api.registerTool("ask_multiple_choice", () => ({}) as never) };
    expect(() => createCapabilityRegistry([coreLearning, clash])).toThrow(/already registered/);
  });

  it("validates every view against the strict wire schema", () => {
    const leaky: Plugin = {
      name: "leaky",
      capabilities: ["artifactKinds"],
      setup: (api) =>
        api.registerArtifactKind({
          kind: "multiple_choice",
          version: 1,
          toolName: "leaky_check",
          description: "",
          spec: coreLearning as never,
          toView: ({ id, createdAt, spec }) => ({ id, createdAt: createdAt.toISOString(), kind: "multiple_choice", version: 1, spec }) as never,
        }),
    };
    const registry = createCapabilityRegistry([leaky]);
    const definition = registry.artifactKind("multiple_choice")!;
    expect(() => registry.viewOf(definition, { id: "a", createdAt: new Date(0), spec: check })).toThrow();
  });
});


it("replays the full redacted continuation to a late subscriber and finishes with no subscriber", async () => {
  for (const subscribe of [true, false]) {
    let release!: () => void;
    let prefixRead!: () => void;
    const ready = new Promise<void>(resolve => { prefixRead = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let prefix = false;
    const stream = new ReadableStream<object>({
      async pull(controller) {
        if (!prefix) {
          prefix = true;
          controller.enqueue({ type: "reasoning-start", id: "PRIVATE-ID", providerMetadata: { vendor: { secret: "PRIVATE-META" } } });
          controller.enqueue({ type: "reasoning-delta", id: "PRIVATE-ID", delta: "Thinking about it." });
          controller.enqueue({ type: "reasoning-end", id: "PRIVATE-ID" });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "Before subscribing. " });
        } else {
          prefixRead();
          await gate;
          controller.enqueue({ type: "text-delta", id: "t", delta: "After subscribing." });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({ type: "tool-call", toolCallId: "private-call", toolName: "ask_multiple_choice", input: JSON.stringify(check) });
          controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage });
          controller.close();
        }
      },
    });
    const { app, db } = setup([
      { toolCall: { name: "ask_multiple_choice", input: check } }, { text: "Try it." },
      { stream }, { text: "Next question." },
    ]);
    const id = await newSession(app);
    expect((await app.request(`/api/sessions/${id}/continuation`)).status).toBe(401);
    expect((await app.request(`/api/sessions/${id}/continuation`, { headers: auth })).status).toBe(204);
    await turn(app, db, id, "quiz");
    const artifact = db.select().from(artifacts).get()!;
    expect((await answer(app, artifact.id, { answer: { optionIndex: 1 } })).status).toBe(201);
    await ready;
    // Let the public stream drain the prefix while the provider is blocked at the gate.
    await new Promise(resolve => setImmediate(resolve));
    const response = subscribe ? await app.request(`/api/sessions/${id}/continuation`, { headers: auth }) : undefined;
    if (response) {
      expect(response.status).toBe(200);
      expect(response.headers.get("x-mivra-continuation-stop-id")).toBeTruthy();
    }
    release();
    if (response) {
      const sse = await response.text();
      for (const text of ["Thinking about it.", "Before subscribing.", "After subscribing.", "data-artifact", "Next question."]) expect(sse).toContain(text);
      for (const secret of [...SECRETS, "PRIVATE-ID", "PRIVATE-META", "private-call", "tool-input", "providerMetadata"]) expect(sse).not.toContain(secret);
    }
    await vi.waitFor(() => expect(db.select().from(runs).all().map(r => r.status)).toEqual(["completed", "completed"]));
    expect(await messagesJson(app, id)).toContain("Before subscribing. After subscribing.");
    expect((await app.request(`/api/sessions/${id}/continuation`, { headers: auth })).status).toBe(204);
    if (response) {
      const stopId = response.headers.get("x-mivra-continuation-stop-id")!;
      // A delayed Stop after completion must not poison the next continuation's cancellation.
      expect((await app.request(`/api/sessions/${id}/stop`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ messageId: stopId }),
      })).status).toBe(204);
      const nextCheck = db.select().from(artifacts).all().find(a => a.id !== artifact.id)!;
      expect((await answer(app, nextCheck.id, { answer: { optionIndex: 1 } })).status).toBe(201);
      await vi.waitFor(() => expect(db.select().from(runs).all().map(r => r.status)).toEqual(["completed", "completed", "completed"]));
    }
    db.$client.close();
  }
});

it("recovers interrupted continuations with a durable retry budget and cooldown, retaining failures", async () => {
  const { app, db } = setup([{ toolCall: { name: "ask_multiple_choice", input: check } }, { text: "Try it." }]);
  const id = await newSession(app);
  await turn(app, db, id, "quiz");
  let clock = new Date();
  const store = createSessionStore(db, () => clock);
  const artifact = db.select().from(artifacts).get()!;
  store.createAttempt({ artifactId: artifact.id, sessionId: id, answer: { optionIndex: 1 }, grade: { correct: true, correctOptionIndex: 1, explanation: "Five." }, correct: true });
  const interrupted = store.startContinuation(id, ["multiple_choice"])!;
  expect(store.startContinuation(id, ["multiple_choice"])).toBeUndefined();
  // A new app over the same durable database performs startup recovery, without an old pump.
  const restarted = setup([{ text: "Recovered lesson." }], db);
  expect(store.latestRun(id)).toMatchObject({ id: interrupted.id, status: "failed" });
  // Inject only the store clock: streaming and the SDK still use real scheduling.
  const registry = createCapabilityRegistry([coreLearning]);
  const recovered = createTurnRunner({ models: fixedModel, store, registry, model: () => restarted.model });
  const subscribe = () => recovered.subscribeContinuation(id);
  const duringCooldown = await Promise.all(Array.from({ length: 4 }, subscribe));
  expect(duringCooldown.every(r => r.status === 204)).toBe(true);
  expect(restarted.model.doStreamCalls).toHaveLength(0);
  clock = new Date(store.latestRun(id)!.endedAt!.getTime() + 30_000);
  const responses = await Promise.all(Array.from({ length: 4 }, subscribe));
  expect(responses.some(r => r.headers.get("x-mivra-continuation-error") === "The model request failed.")).toBe(true);
  await Promise.all(responses.map(r => r.text()));
  expect(db.select().from(runs).all().map(r => r.status)).toEqual(["completed", "failed", "completed"]);
  expect(db.select().from(runs).where(eq(runs.id, interrupted.id)).get()).toMatchObject({
    continuationOf: null, error: "The server stopped before the reply finished",
  });
  expect(restarted.model.doStreamCalls).toHaveLength(1);
  expect(await messagesJson(restarted.app, id)).toContain("Recovered lesson.");
  expect((await restarted.app.request(`/api/sessions/${id}/continuation`, { headers: auth })).status).toBe(204);
  expect(store.startContinuation(id, ["multiple_choice"])).toBeUndefined();
  expect(restarted.model.doStreamCalls).toHaveLength(1);
  // A separate quiz keeps failing. Recreate the store/runner at each check to prove the
  // budget survives restarts and the count does not depend on in-memory ownership.
  const failingSession = store.createSession();
  const quiz = store.startRun(failingSession, userMessage("quiz"));
  const failedCheck = store.createArtifact({ sessionId: failingSession.id, runId: quiz, toolCallId: "fail-check", kind: "multiple_choice", version: 1, spec: check });
  store.finishRun(quiz, failingSession.id, "completed");
  store.createAttempt({ sessionId: failingSession.id, artifactId: failedCheck.id, answer: { optionIndex: 1 }, grade: { correct: true, correctOptionIndex: 1, explanation: "Five." }, correct: true });
  let calls = 0;
  const failingModel = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      return { stream: simulateReadableStream({ chunks: [{ type: "error", error: new Error("provider unavailable") }] }) };
    },
  });
  const freshRunner = () => createTurnRunner({ models: fixedModel,
    store: createSessionStore(db, () => clock), registry,
    model: () => failingModel,
  });
  const initialRunner = freshRunner();
  await initialRunner.continueAfterAnswer(failingSession.id);
  await (await initialRunner.subscribeContinuation(failingSession.id)).text();
  expect(calls).toBe(1);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const failure = store.latestRun(failingSession.id)!;
    expect(failure.status).toBe("failed");
    for (const elapsed of [0, 29_999]) {
      clock = new Date(failure.endedAt!.getTime() + elapsed);
      const checks = await Promise.all(Array.from({ length: 4 }, () => freshRunner().subscribeContinuation(failingSession.id)));
      expect(checks.every(r => r.status === 204 && r.headers.has("x-mivra-continuation-error"))).toBe(true);
      expect(calls).toBe(attempt);
    }
    clock = new Date(failure.endedAt!.getTime() + 30_000);
    const retries = await Promise.all(Array.from({ length: 4 }, () => freshRunner().subscribeContinuation(failingSession.id)));
    await Promise.all(retries.map(response => response.text()));
    expect(calls).toBe(Math.min(attempt + 1, 3));
  }
  clock = new Date(clock.getTime() + 86_400_000);
  await freshRunner().subscribeContinuation(failingSession.id);
  expect(calls).toBe(3);
  expect(db.select().from(runs).all().filter(r => r.sessionId === failingSession.id).map(r => r.status)).toEqual(["completed", "failed", "failed", "failed"]);
  // An accepted learner turn supersedes the exhausted claim even if that turn fails.
  const manual = store.startRun(failingSession, userMessage("continue please"));
  store.finishRun(manual, failingSession.id, "failed");
  await freshRunner().subscribeContinuation(failingSession.id);
  expect(calls).toBe(3);
  // Cancellation is a terminal claim, even if the source quiz is still fully answered.
  const cancelledSession = store.createSession();
  const source = store.startRun(cancelledSession, userMessage("quiz"));
  const cancelledCheck = store.createArtifact({ sessionId: cancelledSession.id, runId: source, toolCallId: "cancel-check", kind: "multiple_choice", version: 1, spec: check });
  store.finishRun(source, cancelledSession.id, "completed");
  store.createAttempt({ sessionId: cancelledSession.id, artifactId: cancelledCheck.id, answer: {}, grade: {}, correct: true });
  const cancelled = store.startContinuation(cancelledSession.id, ["multiple_choice"])!;
  store.finishRun(cancelled.id, cancelledSession.id, "cancelled");
  expect(store.startContinuation(cancelledSession.id, ["multiple_choice"])).toBeUndefined();
  db.$client.close();
});
