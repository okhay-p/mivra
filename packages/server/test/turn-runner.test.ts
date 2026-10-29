import { convertToModelMessages, simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/client.js";
import { createTurnRunner } from "../src/runtime/turn-runner.js";
import { createSessionStore } from "../src/store/session-store.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const model = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t" },
          { type: "text-delta" as const, id: "t", delta: "ok" },
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ],
      }),
    }),
  });

const userMessage = (text: string): UIMessage => ({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });

describe("TurnRunner, used without HTTP", () => {
  it("passes the stored conversation through assembleContext and records the reply", async () => {
    const store = createSessionStore(openDb(":memory:"));
    const session = store.createSession();
    const assembleContext = vi.fn((conversation: UIMessage[]) => convertToModelMessages(conversation));
    const runner = createTurnRunner({ store, model, assembleContext });

    const result = await runner.startTurn({ sessionId: session.id, message: userMessage("hello") });
    expect(result.ok).toBe(true);
    if (result.ok) await result.response.text();

    expect(assembleContext).toHaveBeenCalledOnce();
    expect(assembleContext.mock.calls[0]?.[0].map((m) => m.role)).toEqual(["user"]);
    await vi.waitFor(() => expect(store.loadMessages(session.id).map((m) => m.role)).toEqual(["user", "assistant"]));
  });

  it("reports domain errors instead of HTTP statuses", async () => {
    const store = createSessionStore(openDb(":memory:"));
    const runner = createTurnRunner({ store, model });
    const session = store.createSession();

    expect(await runner.startTurn({ sessionId: "missing", message: userMessage("hi") })).toEqual({
      ok: false,
      error: { kind: "not_found", message: "Session not found" },
    });
    const notUser = await runner.startTurn({ sessionId: session.id, message: { ...userMessage("hi"), role: "assistant" } });
    expect(notUser.ok || notUser.error.kind).toBe("invalid");
  });

  it("records a failed run when context assembly throws", async () => {
    const db = openDb(":memory:");
    const store = createSessionStore(db);
    const session = store.createSession();
    const runner = createTurnRunner({
      store,
      model,
      assembleContext: async () => {
        throw new Error("memory unavailable");
      },
    });

    const result = await runner.startTurn({ sessionId: session.id, message: userMessage("hi") });
    expect(result).toEqual({ ok: false, error: { kind: "unavailable", message: "memory unavailable" } });
    const [run] = db.$client.prepare("select status, error from runs").all() as { status: string; error: string }[];
    expect(run).toEqual({ status: "failed", error: "memory unavailable" });
  });
});
