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

type Step = { toolCall: { name: string; input: unknown } } | { text: string };

/** A model that plays scripted steps in order, one per model call, and records every prompt. */
function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++] ?? { text: "ok" };
      const chunks: object[] =
        "toolCall" in step
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
