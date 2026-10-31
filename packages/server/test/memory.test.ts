import { RememberInput } from "@mivra/protocol";
import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { artifacts, memories, runs } from "../src/db/schema.js";
import { createSessionStore } from "../src/store/session-store.js";

const auth = { authorization: "Bearer t" };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const check = {
  concept: "Binary Search",
  question: "Worst case on 16 items?",
  options: [{ text: "4" }, { text: "5" }],
  correctOptionIndex: 1,
  explanation: "Five.",
};

type Step = { tool: string; input: unknown } | { text: string } | { error: true };

function setup(steps: Step[], db: Db = openDb(":memory:")) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++] ?? { text: "ok" };
      const chunks: object[] =
        "error" in step
          ? [{ type: "error" as const, error: new Error("provider down") }, { type: "finish" as const, finishReason: { unified: "error" as const, raw: "error" }, usage }]
          : "tool" in step
            ? [
                { type: "tool-call" as const, toolCallId: `call_${call}`, toolName: step.tool, input: JSON.stringify(step.input) },
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
  const app = createApp({ db, model: () => model, security: { token: "t", allowedHosts: [] } });

  const turn = async (sessionId: string, text: string) => {
    const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
    const res = await app.request(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const sse = await res.text();
    await vi.waitFor(() => expect(db.select().from(runs).where(eq(runs.sessionId, sessionId)).all().every((r) => r.status !== "running")).toBe(true));
    return sse;
  };
  const newSession = async () => ((await (await app.request("/api/sessions", { method: "POST", headers: auth })).json()) as { id: string }).id;
  const list = async () =>
    (await (await app.request("/api/memories", { headers: auth })).json()) as { id: string; held: boolean; text: string | null; basis: string | null; editedAt: string | null }[];
  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const promptOf = (index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt);
  return { app, db, turn, newSession, list, send, promptOf };
}

const goal = { kind: "goal", text: "SECRET-GOAL pass interviews" };
const remember = (input: unknown): Step => ({ tool: "remember", input });

describe("remember", () => {
  it("rejects an empty input, as every tool schema must", () => {
    expect(RememberInput.safeParse({}).success).toBe(false);
  });

  it("requires a concept for a misconception, so it can be linked to an answer", async () => {
    expect(RememberInput.safeParse({ kind: "misconception", text: "x" }).success).toBe(false);
    expect(RememberInput.safeParse({ kind: "misconception", text: "x", concept: "heaps" }).success).toBe(true);
    expect(RememberInput.safeParse({ kind: "goal", text: "x" }).success).toBe(true);

    const { turn, newSession, list, promptOf } = setup([remember({ kind: "misconception", text: "No concept given" }), { text: "ok" }]);
    await turn(await newSession(), "hello");
    expect(await list()).toEqual([]);
    // The model is told why, so it can try again.
    expect(promptOf(1)).toContain("A misconception needs a concept");
  });

  it("reaches a new session without the old chat, and the call never reaches the client", async () => {
    const { turn, newSession, list, promptOf } = setup([remember(goal), { text: "Noted." }, { text: "Welcome back." }]);
    const sse = await turn(await newSession(), "I want to pass interviews");
    expect(sse).not.toContain("SECRET-GOAL");
    expect(sse).not.toContain("remember");
    expect((await list()).map((m) => m.text)).toEqual([goal.text]);

    await turn(await newSession(), "hi");
    expect(promptOf(2)).toContain("SECRET-GOAL");
    expect(promptOf(2)).not.toContain("I want to pass interviews");
  });

  it("isn't saved in the conversation, so a later turn in the session still works", async () => {
    const { app, db, turn, newSession, send, promptOf } = setup([remember(goal), { text: "Noted." }, { text: "Next." }]);
    const session = await newSession();
    await turn(session, "hello");
    const stored = await (await app.request(`/api/sessions/${session}/messages`, { headers: auth })).text();
    expect(stored).not.toContain("SECRET-GOAL");
    expect(JSON.stringify(createSessionStore(db).loadMessages(session))).not.toContain("SECRET-GOAL");

    const [memory] = createSessionStore(db).listMemoriesForLearner([]);
    expect((await send(`/api/memories/${memory!.id}`, "DELETE")).status).toBe(204);
    await turn(session, "again");
    expect(promptOf(2)).not.toContain("SECRET-GOAL");
    expect(promptOf(2)).toContain("Noted.");
  });

  it("is discarded if its reply fails", async () => {
    const { db, turn, newSession, list } = setup([remember(goal), { error: true }]);
    await turn(await newSession(), "hello");
    expect(await list()).toEqual([]);
    expect(db.select().from(memories).all()).toEqual([]);
  });

  it("is discarded if the server stopped before its reply finished", () => {
    const db = openDb(":memory:");
    const store = createSessionStore(db);
    const session = store.createSession();
    const runId = store.startRun(session, { id: "m", role: "user", parts: [] });
    store.saveMemory({ sessionId: session.id, runId, kind: "goal", text: "x", concept: null, basis: "chat", attemptId: null, replaces: null });
    createApp({ db, model: () => { throw new Error("unused"); }, security: { token: "t", allowedHosts: [] } });
    expect(db.select().from(memories).all()).toEqual([]);
  });

  it("doesn't repeat a known memory", async () => {
    const { turn, newSession, list } = setup([remember(goal), { text: "a" }, remember({ ...goal, text: `  ${goal.text.toLowerCase()} ` }), { text: "b" }]);
    await turn(await newSession(), "one");
    await turn(await newSession(), "two");
    expect(await list()).toHaveLength(1);
  });

  it("links a misconception to a wrong answer on the same concept, whatever the model claims", async () => {
    const { db, turn, newSession, list, send } = setup([
      remember({ kind: "misconception", text: "No evidence yet", concept: "binary search" }),
      { text: "Noted." },
      { tool: "ask_multiple_choice", input: check },
      { text: "Try it." },
      remember({ kind: "misconception", text: "Thinks four comparisons suffice", concept: "  BINARY   search" }),
      remember({ kind: "misconception", text: "Other concept", concept: "heaps" }),
      { text: "Noted." },
    ]);
    const session = await newSession();
    await turn(session, "chat first");
    await turn(session, "quiz me");
    await send(`/api/artifacts/${db.select().from(artifacts).get()!.id}/attempts`, "POST", { answer: { optionIndex: 0 } });
    await turn(session, "I answered");

    const byText = Object.fromEntries((await list()).map((m) => [m.text, m.basis]));
    expect(byText).toEqual({ "No evidence yet": "chat", "Thinks four comparisons suffice": "wrong_answer", "Other concept": "chat" });
  });

  it("doesn't count a correct answer as support for a misconception", async () => {
    const { db, turn, newSession, list, send } = setup([
      { tool: "ask_multiple_choice", input: check },
      { text: "Try it." },
      remember({ kind: "misconception", text: "Not backed by anything", concept: "binary search" }),
      { text: "Noted." },
    ]);
    const session = await newSession();
    await turn(session, "quiz me");
    await send(`/api/artifacts/${db.select().from(artifacts).get()!.id}/attempts`, "POST", { answer: { optionIndex: 1 } });
    await turn(session, "I answered");
    expect((await list()).map((m) => m.basis)).toEqual(["chat"]);
  });

  it("replaces a memory only when the reply completes, and refuses unknown ids", async () => {
    const { db, turn, newSession, list } = setup([remember(goal), { text: "a" }, remember({ kind: "goal", text: "Unknown target", replaces: "nope" }), { text: "b" }]);
    await turn(await newSession(), "one");
    const [old] = await list();
    await turn(await newSession(), "two");
    expect((await list()).map((m) => m.text)).toEqual([goal.text]);

    const next = setup([remember({ kind: "goal", text: "New goal", replaces: old!.id }), { error: true }, remember({ kind: "goal", text: "Newer goal", replaces: old!.id }), { text: "c" }], db);
    await next.turn(await next.newSession(), "three");
    expect((await list()).map((m) => m.text)).toEqual([goal.text]);
    await next.turn(await next.newSession(), "four");
    expect((await list()).map((m) => m.text)).toEqual(["Newer goal"]);
  });
});

describe("memory written around an unanswered check", () => {
  const leak = { kind: "goal", text: "SECRET the answer to the current check is 5" };

  it("is held until the check is answered: hidden from the panel and other sessions, but deletable", async () => {
    const { db, app, turn, newSession, list, send, promptOf } = setup([
      { tool: "ask_multiple_choice", input: check },
      remember(leak),
      { text: "Try it." },
      { text: "Other session." },
      { text: "After answering." },
    ]);
    const session = await newSession();
    await turn(session, "quiz me");

    const body = await (await app.request("/api/memories", { headers: auth })).text();
    expect(body).not.toContain("SECRET");
    const [memory] = await list();
    expect(memory).toMatchObject({ held: true, text: null, basis: null });
    expect((await send(`/api/memories/${memory!.id}`, "PATCH", { text: "changed" })).status).toBe(409);

    await turn(await newSession(), "hello");
    expect(promptOf(3)).not.toContain("SECRET");

    await send(`/api/artifacts/${db.select().from(artifacts).get()!.id}/attempts`, "POST", { answer: { optionIndex: 0 } });
    expect(await list()).toMatchObject([{ held: false, text: leak.text }]);
    await turn(await newSession(), "hello again");
    expect(promptOf(4)).toContain("SECRET");
  });

  it("holds for a check asked after the memory in the same reply, and for one from an earlier reply", async () => {
    const same = setup([remember(leak), { tool: "ask_multiple_choice", input: check }, { text: "Try it." }]);
    await same.turn(await same.newSession(), "quiz me");
    expect(await same.list()).toMatchObject([{ held: true }]);

    const earlier = setup([{ tool: "ask_multiple_choice", input: check }, { text: "Try it." }, remember(leak), { text: "Noted." }]);
    const session = await earlier.newSession();
    await earlier.turn(session, "quiz me");
    await earlier.turn(session, "still thinking");
    expect(await earlier.list()).toMatchObject([{ held: true }]);
  });

  it("isn't held by a trace, or by a check asked in a later reply", async () => {
    const trace = { title: "T", values: [1], steps: [{ explanation: "E" }] };
    const { db, turn, newSession, list } = setup([
      { tool: "show_algorithm_trace", input: trace },
      remember(goal),
      { text: "a" },
      { tool: "ask_multiple_choice", input: check },
      { text: "b" },
    ]);
    const session = await newSession();
    await turn(session, "show me");
    expect(await list()).toMatchObject([{ held: false }]);
    await turn(session, "quiz me");
    expect(db.select().from(artifacts).all()).toHaveLength(2);
    expect(await list()).toMatchObject([{ held: false }]);
  });
});

describe("memory changing while another reply is running", () => {
  const start = (store: ReturnType<typeof createSessionStore>) => {
    const session = store.createSession();
    const runId = store.startRun(session, { id: crypto.randomUUID(), role: "user", parts: [] });
    const save = (text: string, replaces: string | null = null) => {
      const saved = store.saveMemory({ sessionId: session.id, runId, kind: "goal", text, concept: null, basis: "chat", attemptId: null, replaces });
      if (!saved.ok) throw new Error(saved.reason);
      return saved.memory;
    };
    return { save, finish: () => store.finishRun(runId, session.id, "completed") };
  };
  const active = (store: ReturnType<typeof createSessionStore>) => store.listMemoriesForLearner([]).map((m) => m.text);
  const seed = (store: ReturnType<typeof createSessionStore>) => {
    const run = start(store);
    const memory = run.save("A");
    run.finish();
    return memory;
  };

  it("a memory deleted while its replacement is pending doesn't come back", () => {
    const db = openDb(":memory:");
    const store = createSessionStore(db);
    const a = seed(store);
    const run = start(store);
    run.save("B", a.id);
    expect(store.deleteMemory(a.id)).toBe(true);
    run.finish();
    expect(active(store)).toEqual([]);
    expect(db.select().from(memories).all()).toEqual([]);
  });

  it("only the first of two concurrent replacements wins, across runs and within one", () => {
    const store = createSessionStore(openDb(":memory:"));
    const a = seed(store);
    const first = start(store);
    const second = start(store);
    first.save("B", a.id);
    second.save("C", a.id);
    first.finish();
    second.finish();
    expect(active(store)).toEqual(["B"]);

    const again = createSessionStore(openDb(":memory:"));
    const x = seed(again);
    const run = start(again);
    run.save("B", x.id);
    run.save("C", x.id);
    run.finish();
    expect(active(again)).toEqual(["B"]);
  });

  it("a learner's edit isn't overwritten by a replacement written before it", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 31), toFake: ["Date"] });
    try {
      const store = createSessionStore(openDb(":memory:"));
      const a = seed(store);
      const edit = (id: string, text: string) => {
        vi.advanceTimersByTime(1000);
        expect(store.editMemory(id, text, []).ok).toBe(true);
        vi.advanceTimersByTime(1000);
      };

      // Edited after the replacement was written.
      const afterSave = start(store);
      afterSave.save("B", a.id);
      edit(a.id, "Learner's words");
      afterSave.finish();
      expect(active(store)).toEqual(["Learner's words"]);

      // Edited after the model read its context, but before it wrote the replacement.
      const beforeSave = start(store);
      edit(a.id, "Learner's second words");
      beforeSave.save("C", a.id);
      beforeSave.finish();
      expect(active(store)).toEqual(["Learner's second words"]);

      // Edited before the reply started, so the model saw it and may replace it.
      const afterEdit = start(store);
      vi.advanceTimersByTime(1000);
      afterEdit.save("D", a.id);
      afterEdit.finish();
      expect(active(store)).toEqual(["D"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("identical memories from concurrent replies become one, even if one reply fails", () => {
    const store = createSessionStore(openDb(":memory:"));
    const first = start(store);
    const second = start(store);
    first.save("Same goal");
    second.save(" same GOAL ");
    first.finish();
    second.finish();
    expect(active(store)).toEqual(["Same goal"]);

    const other = createSessionStore(openDb(":memory:"));
    const failing = other.createSession();
    const failingRun = other.startRun(failing, { id: "f", role: "user", parts: [] });
    other.saveMemory({ sessionId: failing.id, runId: failingRun, kind: "goal", text: "Same goal", concept: null, basis: "chat", attemptId: null, replaces: null });
    const ok = start(other);
    ok.save("Same goal");
    other.finishRun(failingRun, failing.id, "failed");
    ok.finish();
    expect(active(other)).toEqual(["Same goal"]);
  });

  it("limits how many memories one reply can write", () => {
    const store = createSessionStore(openDb(":memory:"));
    const run = start(store);
    for (let i = 0; i < 5; i++) run.save(`m${i}`);
    expect(() => run.save("one too many")).toThrow("at most 5");
    run.save("m0"); // A repeat isn't a new memory.
    run.finish();
    expect(active(store)).toHaveLength(5);
  });

  it("finds a wrong answer however many attempts came after it", () => {
    const store = createSessionStore(openDb(":memory:"));
    const session = store.createSession();
    const runId = store.startRun(session, { id: "m", role: "user", parts: [] });
    const record = (toolCallId: string, correct: boolean, concept: string) => {
      const artifact = store.createArtifact({ sessionId: session.id, runId, toolCallId, kind: "multiple_choice", version: 1, spec: check });
      return store.createAttempt({ artifactId: artifact.id, sessionId: session.id, answer: {}, grade: {}, correct, concept });
    };
    const wrong = record("old", false, "heaps");
    for (let i = 0; i < 1001; i++) record(`later${i}`, true, "other");
    expect(store.findLatestWrongAnswer((c) => c === "heaps")?.id).toBe(wrong.id);
    expect(store.findLatestWrongAnswer((c) => c === "missing")).toBeUndefined();
  });
});

describe("memory API", () => {
  it("needs the API token", async () => {
    const { app } = setup([]);
    expect((await app.request("/api/memories")).status).toBe(401);
  });

  it("edits a memory, marks it for the model, and validates the text", async () => {
    const { turn, newSession, list, send, promptOf } = setup([remember(goal), { text: "a" }, { text: "b" }]);
    await turn(await newSession(), "one");
    const [memory] = await list();

    expect((await send(`/api/memories/${memory!.id}`, "PATCH", { text: "   " })).status).toBe(400);
    expect((await send(`/api/memories/${memory!.id}`, "PATCH", { text: "x".repeat(301) })).status).toBe(400);
    expect((await send("/api/memories/nope", "PATCH", { text: "x" })).status).toBe(404);

    const res = await send(`/api/memories/${memory!.id}`, "PATCH", { text: "Corrected goal" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "Corrected goal", editedAt: expect.any(String) });

    await turn(await newSession(), "two");
    expect(promptOf(2)).toContain("Corrected goal");
    expect(promptOf(2)).toContain("editedByLearner");
    expect(promptOf(2)).not.toContain("SECRET-GOAL");
  });

  it("deletes a memory with the earlier versions it replaced", async () => {
    const db = openDb(":memory:");
    const first = setup([remember(goal), { text: "a" }], db);
    await first.turn(await first.newSession(), "one");
    const [old] = await first.list();
    const second = setup([remember({ kind: "goal", text: "Newer goal", replaces: old!.id }), { text: "b" }], db);
    await second.turn(await second.newSession(), "two");
    const [current] = await second.list();
    expect(db.select().from(memories).all()).toHaveLength(2);

    expect((await second.send(`/api/memories/${old!.id}`, "DELETE")).status).toBe(404);
    expect((await second.send(`/api/memories/${current!.id}`, "DELETE")).status).toBe(204);
    expect(db.select().from(memories).all()).toEqual([]);
    expect((await second.send(`/api/memories/${current!.id}`, "DELETE")).status).toBe(404);
  });
});
