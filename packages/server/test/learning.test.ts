import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { artifacts, attempts, runs } from "../src/db/schema.js";
import { coreLearning } from "../src/plugins/core-learning.js";
import { createCapabilityRegistry, type Plugin } from "../src/runtime/capabilities.js";
import { createSessionStore } from "../src/store/session-store.js";

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

  it("keeps model reasoning out of the stream and reloaded messages", async () => {
    const { app, db } = setup([
      { raw: [...leakyReasoning, { type: "tool-call", toolCallId: "c1", toolName: "ask_multiple_choice", input: JSON.stringify(check) }] },
      { text: "Try it." },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "quiz me");
    const reloaded = await messagesJson(app, sessionId);
    for (const body of [sse, reloaded]) {
      for (const secret of SECRETS) expect(body).not.toContain(secret);
      expect(body).not.toContain("reasoning");
    }
    expect(sse).toContain('"type":"data-artifact"');
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
      "Unknown model or provider. Check MIVRA_MODEL in .env.",
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

describe("invalid tool input", () => {
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
