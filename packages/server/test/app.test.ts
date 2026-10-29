import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { messages, runs, sessions } from "../src/db/schema.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage };

/** A model that replies with fixed text. */
function replyModel(reply: string[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t1" },
          ...reply.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
          { type: "text-end" as const, id: "t1" },
          finish,
        ],
      }),
    }),
  });
}

/** A model whose stream the test drives step by step. The stream opens lazily, once the response is read. */
function controlledModel() {
  let opened!: (c: ReadableStreamDefaultController) => void;
  const ready = new Promise<ReadableStreamDefaultController>((resolve) => (opened = resolve));
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: "text-start", id: "t1" });
          abortSignal?.addEventListener("abort", () => {
            try {
              c.error(new DOMException("Aborted", "AbortError"));
            } catch {
              // Already closed.
            }
          });
          opened(c);
        },
      });
      return { stream };
    },
  });
  return {
    model,
    push: async (delta: string) => (await ready).enqueue({ type: "text-delta", id: "t1", delta }),
    finish: async () => {
      const c = await ready;
      c.enqueue({ type: "text-end", id: "t1" });
      c.enqueue(finish);
      c.close();
    },
    fail: async (message: string) => {
      const c = await ready;
      c.enqueue({ type: "error", error: new Error(message) });
      c.close();
    },
  };
}

function setup(model: MockLanguageModelV4 = replyModel(["Hello", ", learner!"]), db: Db = openDb(":memory:")) {
  const app = createApp({ db, model: () => model, security: { token: TOKEN, allowedHosts: [] } });
  return { app, db, model };
}

type App = ReturnType<typeof setup>["app"];

const userMessage = (text: string, id: string = crypto.randomUUID()): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

async function createSession(app: App) {
  const res = await app.request("/api/sessions", { method: "POST", headers: auth });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

function send(app: App, sessionId: string, message: UIMessage, init: RequestInit = {}) {
  return app.request(`/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ message }),
    ...init,
  });
}

async function getMessages(app: App, sessionId: string) {
  return (await (await app.request(`/api/sessions/${sessionId}/messages`, { headers: auth })).json()) as UIMessage[];
}

const runsFor = (db: Db, sessionId: string) => db.select().from(runs).where(eq(runs.sessionId, sessionId)).all();

describe("access control", () => {
  it("allows health checks without a token", async () => {
    const res = await setup().app.request("/api/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects API requests without the token", async () => {
    const { app } = setup();
    expect((await app.request("/api/sessions")).status).toBe(401);
    expect((await app.request("/api/sessions", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/api/sessions", { method: "POST" })).status).toBe(401);
  });

  it("rejects requests for a non-loopback Host (DNS rebinding)", async () => {
    const res = await setup().app.request("http://attacker.example/api/sessions", { headers: auth });
    expect(res.status).toBe(403);
  });

  it("accepts explicitly allowed hosts", async () => {
    const app = createApp({
      db: openDb(":memory:"),
      model: () => replyModel([]),
      security: { token: TOKEN, allowedHosts: ["prestige.example.ts.net"] },
    });
    const res = await app.request("http://prestige.example.ts.net/api/sessions", { headers: auth });
    expect(res.status).toBe(200);
  });
});

describe("sessions", () => {
  it("creates and lists sessions", async () => {
    const { app } = setup();
    const session = await createSession(app);
    const list = (await (await app.request("/api/sessions", { headers: auth })).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toEqual([session.id]);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await setup().app.request("/api/sessions/nope/messages", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("serves an OpenAPI document whose paths resolve under /api", async () => {
    const doc = (await (await setup().app.request("/api/doc")).json()) as {
      paths: Record<string, unknown>;
      servers: { url: string }[];
    };
    expect(doc.servers).toEqual([{ url: "/api" }]);
    expect(Object.keys(doc.paths)).toContain("/sessions/{id}/chat");
  });
});

describe("chat turns", () => {
  it("streams a reply over SSE and persists both messages in order", async () => {
    const { app, db, model } = setup();
    const session = await createSession(app);

    const res = await send(app, session.id, userMessage("What is a sliding window?"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain('"delta":"Hello"');
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("What is a sliding window?");

    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("completed"));
    const saved = await getMessages(app, session.id);
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(saved[1]?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Hello, learner!" }));
    expect(runsFor(db, session.id)[0]?.assistantMessageId).toBe(saved[1]?.id);

    const [renamed] = (await (await app.request("/api/sessions", { headers: auth })).json()) as { title: string }[];
    expect(renamed?.title).toBe("What is a sliding window?");
  });

  it("sends earlier messages as history on the next turn", async () => {
    const { app, db, model } = setup();
    const session = await createSession(app);

    await (await send(app, session.id, userMessage("first question"))).text();
    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("completed"));
    await (await send(app, session.id, userMessage("second question"))).text();

    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(prompt).toContain("first question");
    expect(prompt).toContain("Hello, learner!");
    expect(prompt).toContain("second question");
  });

  it("orders messages by sequence, not timestamp", async () => {
    const { app, db } = setup();
    const session = await createSession(app);
    await (await send(app, session.id, userMessage("one"))).text();
    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("completed"));
    // Force identical timestamps; order must still come from seq.
    db.update(messages).set({ createdAt: new Date(0) }).run();
    const seqs = db.select({ seq: messages.seq }).from(messages).all().map((r) => r.seq);
    expect(seqs.sort()).toEqual([1, 2]);
    expect((await getMessages(app, session.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("rejects non-user messages", async () => {
    const { app } = setup();
    const session = await createSession(app);
    const res = await send(app, session.id, { ...userMessage("hi"), role: "assistant" });
    expect(res.status).toBe(400);
  });

  it("rejects a message id already used in another session, leaving the original untouched", async () => {
    const { app, db } = setup();
    const a = await createSession(app);
    const b = await createSession(app);
    await (await send(app, a.id, userMessage("original", "shared-id"))).text();
    await vi.waitFor(() => expect(runsFor(db, a.id)[0]?.status).toBe("completed"));

    const res = await send(app, b.id, userMessage("hijack", "shared-id"));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await getMessages(app, a.id))).toContain("original");
    expect(await getMessages(app, b.id)).toEqual([]);
    expect(runsFor(db, b.id)).toEqual([]);
  });

  it("rejects an assistant message's id being reused for a user message", async () => {
    const { app, db } = setup();
    const session = await createSession(app);
    await (await send(app, session.id, userMessage("q"))).text();
    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("completed"));
    const assistantId = (await getMessages(app, session.id))[1]!.id;

    const res = await send(app, session.id, userMessage("overwrite", assistantId));
    expect(res.status).toBe(409);
    expect((await getMessages(app, session.id))[1]?.role).toBe("assistant");
  });

  it("treats a retried message id as a duplicate instead of generating twice", async () => {
    const { app, db, model } = setup();
    const session = await createSession(app);
    const message = userMessage("same request");
    await (await send(app, session.id, message)).text();
    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("completed"));

    expect((await send(app, session.id, message)).status).toBe(409);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(await getMessages(app, session.id)).toHaveLength(2);
  });

  it("rejects a second send while a reply is still streaming", async () => {
    const control = controlledModel();
    const { app, db } = setup(control.model);
    const session = await createSession(app);

    const first = await send(app, session.id, userMessage("first"));
    expect(first.status).toBe(200);
    const second = await send(app, session.id, userMessage("second"));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "A reply is already in progress for this session" });

    const body = first.text();
    await control.push("answer");
    await control.finish();
    await body;
    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("completed"));
    expect((await getMessages(app, session.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((await send(app, session.id, userMessage("third"))).status).toBe(200);
  });

  it("records a stopped reply as cancelled and does not save the partial text", async () => {
    const control = controlledModel();
    const { app, db } = setup(control.model);
    const session = await createSession(app);
    const abort = new AbortController();

    const res = await send(app, session.id, userMessage("explain"), { signal: abort.signal });
    const reader = res.body!.getReader();
    const firstChunk = reader.read();
    await control.push("partial");
    await firstChunk;
    abort.abort();
    await reader.cancel().catch(() => {});

    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("cancelled"));
    expect((await getMessages(app, session.id)).map((m) => m.role)).toEqual(["user"]);
    expect(JSON.stringify(await getMessages(app, session.id))).not.toContain("partial");
  });

  it("records a client disconnect as cancelled and frees the session", async () => {
    const control = controlledModel();
    const { app, db } = setup(control.model);
    const session = await createSession(app);

    const res = await send(app, session.id, userMessage("explain"));
    const reader = res.body!.getReader();
    const firstChunk = reader.read();
    await control.push("partial");
    await firstChunk;
    await reader.cancel();

    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("cancelled"));
    expect(runsFor(db, session.id)[0]?.endedAt).not.toBeNull();
  });

  it("records a provider error as a failed run with the error", async () => {
    const control = controlledModel();
    const { app, db } = setup(control.model);
    const session = await createSession(app);

    const res = await send(app, session.id, userMessage("explain"));
    const body = res.text();
    await control.fail("provider exploded");
    expect(await body).toContain("provider exploded");

    await vi.waitFor(() => expect(runsFor(db, session.id)[0]?.status).toBe("failed"));
    expect(runsFor(db, session.id)[0]?.error).toContain("provider exploded");
    expect((await getMessages(app, session.id)).map((m) => m.role)).toEqual(["user"]);
  });

  it("returns 500 without writing anything when the model cannot be resolved", async () => {
    const db = openDb(":memory:");
    const app = createApp({
      db,
      model: () => {
        throw new Error("Unknown provider");
      },
      security: { token: TOKEN, allowedHosts: [] },
    });
    const session = await createSession(app);
    const res = await send(app, session.id, userMessage("hi"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Unknown provider" });
    expect(db.select().from(messages).all()).toEqual([]);
  });
});

describe("persistence", () => {
  it("marks runs left running by a previous process as failed on startup", () => {
    const db = openDb(":memory:");
    const now = new Date();
    db.insert(sessions).values({ id: "s", title: "t", createdAt: now, updatedAt: now }).run();
    db.insert(messages).values({ id: "m", sessionId: "s", seq: 1, role: "user", parts: [], createdAt: now }).run();
    db.insert(runs).values({ id: "r", sessionId: "s", userMessageId: "m", status: "running", startedAt: now }).run();

    setup(replyModel([]), db);
    const [run] = runsFor(db, "s");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/stopped/);
  });

  it("keeps data across a database reopen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "mivra-test-")), "mivra.db");
    const first = setup(replyModel(["kept"]), openDb(path));
    const session = await createSession(first.app);
    await (await send(first.app, session.id, userMessage("remember me"))).text();
    await vi.waitFor(() => expect(runsFor(first.db, session.id)[0]?.status).toBe("completed"));
    first.db.$client.close();

    const second = setup(replyModel([]), openDb(path));
    expect((await getMessages(second.app, session.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
