import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { createSessionStore } from "../src/store/session-store.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function setup() {
  const db = openDb(":memory:");
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Hello" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ],
      }) as never,
    }),
  });
  const app = createApp({ db, model: () => model, security: { token: TOKEN, allowedHosts: [] } });
  return { app, store: createSessionStore(db) };
}
type App = ReturnType<typeof setup>["app"];

const rename = (app: App, id: string, body: unknown) =>
  app.request(`/api/sessions/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
const create = async (app: App) => (await (await app.request("/api/sessions", { method: "POST", headers: json, body: "{}" })).json()) as { id: string; title: string };
const listed = async (app: App) => (await (await app.request("/api/sessions", { headers: auth })).json()) as { id: string; title: string; courseId: string | null }[];

describe("PATCH /api/sessions/{id}", () => {
  it("renames a chat with the trimmed title, without moving it in the sidebar", async () => {
    const { app, store } = setup();
    const older = await create(app);
    await create(app);
    const before = (await listed(app)).map((s) => s.id);
    const res = await rename(app, older.id, { title: "  Limits, properly  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: older.id, title: "Limits, properly", courseId: null });
    expect((await listed(app)).map((s) => s.id)).toEqual(before);
    expect(store.findSession(older.id)).toMatchObject({ title: "Limits, properly", titleSetByLearner: true });
  });

  it("renames a course, keeping it a course", async () => {
    const { app } = setup();
    const started = (await (await app.request("/api/courses", { method: "POST", headers: json, body: JSON.stringify({ goal: "Learn real analysis" }) })).json()) as {
      course: { id: string };
      session: { id: string };
    };
    const res = await rename(app, started.session.id, { title: "Analysis" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Analysis", courseId: started.course.id });
    expect((await listed(app)).find((s) => s.id === started.session.id)).toMatchObject({ title: "Analysis", courseId: started.course.id });
  });

  it("accepts 120 characters and rejects empty, blank and longer titles", async () => {
    const { app, store } = setup();
    const { id } = await create(app);
    expect((await rename(app, id, { title: "x".repeat(120) })).status).toBe(200);
    for (const title of ["", "   ", "x".repeat(121)]) {
      const res = await rename(app, id, { title });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "A title needs 1 to 120 characters." });
    }
    expect((await rename(app, id, {})).status).toBe(400);
    expect(store.findSession(id)?.title).toBe("x".repeat(120));
  });

  it("returns 404 for an unknown session", async () => {
    const { app } = setup();
    expect((await rename(app, "missing", { title: "Anything" })).status).toBe(404);
  });

  it("keeps a learner's title when the first message would otherwise name the session", async () => {
    const { app, store } = setup();
    const renamed = await create(app);
    const untouched = await create(app);
    await rename(app, renamed.id, { title: "My notes" });
    for (const { id } of [renamed, untouched]) {
      const res = await app.request(`/api/sessions/${id}/chat`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ message: { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "What is a limit?" }] } }),
      });
      await res.text();
    }
    expect(store.findSession(renamed.id)?.title).toBe("My notes");
    expect(store.findSession(untouched.id)?.title).toBe("What is a limit?");
  });
});
