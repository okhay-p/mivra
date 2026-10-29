import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";

function mockModel(reply: string[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t1" },
          ...reply.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
          { type: "text-end" as const, id: "t1" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: reply.length, text: reply.length, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  });
}

function setup(reply = ["Hello", ", learner!"]) {
  const model = mockModel(reply);
  const app = createApp({ db: openDb(":memory:"), model: () => model });
  return { app, model };
}

const userMessage = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});

async function createSession(app: ReturnType<typeof setup>["app"]) {
  const res = await app.request("/api/sessions", { method: "POST" });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

describe("api", () => {
  it("reports health", async () => {
    const res = await setup().app.request("/api/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates and lists sessions", async () => {
    const { app } = setup();
    const session = await createSession(app);
    const list = (await (await app.request("/api/sessions")).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toEqual([session.id]);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await setup().app.request("/api/sessions/nope/messages");
    expect(res.status).toBe(404);
  });

  it("streams a reply over SSE and persists both messages", async () => {
    const { app, model } = setup();
    const session = await createSession(app);

    const res = await app.request(`/api/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: userMessage("What is a sliding window?") }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"delta":"Hello"');

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("What is a sliding window?");

    const messages = (await (await app.request(`/api/sessions/${session.id}/messages`)).json()) as UIMessage[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Hello, learner!" }));

    const [renamed] = (await (await app.request("/api/sessions")).json()) as { title: string }[];
    expect(renamed?.title).toBe("What is a sliding window?");
  });

  it("sends earlier messages as history on the next turn", async () => {
    const { app, model } = setup();
    const session = await createSession(app);
    const send = async (text: string) => {
      const res = await app.request(`/api/sessions/${session.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: userMessage(text) }),
      });
      return res.text();
    };

    await send("first question");
    await send("second question");
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(prompt).toContain("first question");
    expect(prompt).toContain("Hello, learner!");
    expect(prompt).toContain("second question");
  });

  it("rejects non-user messages", async () => {
    const { app } = setup();
    const session = await createSession(app);
    const res = await app.request(`/api/sessions/${session.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { ...userMessage("hi"), role: "assistant" } }),
    });
    expect(res.status).toBe(400);
  });

  it("serves an OpenAPI document", async () => {
    const doc = (await (await setup().app.request("/api/doc")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/sessions/{id}/chat");
  });
});
