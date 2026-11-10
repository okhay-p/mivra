import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { courses, runs } from "../src/db/schema.js";

// The tutor's course title and subject icon, written with the first syllabus (#58).

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const GOAL = "i want to learn induction in discrete math including strong induction and well ordering";

/** Calls write_syllabus with the given extra fields on its first step, then says "ok". */
function setup(extra: Record<string, unknown>) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks: object[] =
        call++ === 0
          ? [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "write_syllabus",
                input: JSON.stringify({
                  ...extra,
                  topics: [{ title: "Weak induction", summary: "The base case and step.", reason: "Your goal.", requestedByLearner: false, concepts: ["induction"] }],
                  known: [],
                }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "ok" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
  const db = openDb(":memory:");
  const app = createApp({ db, model: () => model, security: { token: TOKEN, allowedHosts: [] } });
  return { app, db };
}
type App = ReturnType<typeof setup>["app"];
type SessionJson = { id: string; title: string; courseId: string | null; icon: string | null };

async function startCourse(app: App) {
  const res = await app.request("/api/courses", { method: "POST", headers: json, body: JSON.stringify({ goal: GOAL }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { course: { id: string }; session: SessionJson };
}

/** One learner turn, in which the tutor writes the syllabus. */
async function writeSyllabus(app: App, db: Db, sessionId: string) {
  const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Skip the questions" }] };
  const res = await app.request(`/api/sessions/${sessionId}/chat`, { method: "POST", headers: json, body: JSON.stringify({ message }) });
  expect(res.status).toBe(200);
  await res.text();
  await vi.waitFor(() => expect(db.select().from(runs).where(eq(runs.sessionId, sessionId)).all().every((r) => r.status !== "running")).toBe(true), {
    timeout: 15_000,
  });
  const course = (await (await app.request(`/api/sessions/${sessionId}/course`, { headers: auth })).json()) as { status: string; syllabus: unknown };
  // Whatever the title and icon were, the syllabus itself is written.
  expect(course.status).toBe("active");
  expect(course.syllabus).not.toBeNull();
}

const listed = async (app: App, id: string) =>
  ((await (await app.request("/api/sessions", { headers: auth })).json()) as SessionJson[]).find((s) => s.id === id)!;

describe("course title and icon", () => {
  it("starts with the goal as the title and no icon", async () => {
    const { app } = setup({});
    const { session } = await startCourse(app);
    expect(session).toMatchObject({ title: GOAL.slice(0, 60), icon: null });
    expect(await listed(app, session.id)).toMatchObject({ title: GOAL.slice(0, 60), icon: null });
  });

  it("takes the tutor's title and icon with the first syllabus", async () => {
    const { app, db } = setup({ title: "  Discrete Math: Induction ", icon: "sigma" });
    const { session } = await startCourse(app);
    await writeSyllabus(app, db, session.id);
    expect(await listed(app, session.id)).toMatchObject({ title: "Discrete Math: Induction", icon: "sigma" });
  });

  it("keeps no icon for a name that isn't on the list, and still takes the title", async () => {
    const { app, db } = setup({ title: "Discrete Math: Induction", icon: "rocket" });
    const { session } = await startCourse(app);
    await writeSyllabus(app, db, session.id);
    expect(await listed(app, session.id)).toMatchObject({ title: "Discrete Math: Induction", icon: null });
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "x".repeat(61)],
    ["not a string", 42],
    ["missing", undefined],
  ])("keeps the goal as the title when the tutor's is %s", async (_, title) => {
    const { app, db } = setup({ title, icon: "atom" });
    const { session } = await startCourse(app);
    await writeSyllabus(app, db, session.id);
    expect(await listed(app, session.id)).toMatchObject({ title: GOAL.slice(0, 60), icon: "atom" });
  });

  it("never replaces a title the learner set, but still takes the icon", async () => {
    const { app, db } = setup({ title: "Discrete Math: Induction", icon: "sigma" });
    const { session } = await startCourse(app);
    const renamed = await app.request(`/api/sessions/${session.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ title: "My proofs" }) });
    expect(renamed.status).toBe(200);
    await writeSyllabus(app, db, session.id);
    expect(await listed(app, session.id)).toMatchObject({ title: "My proofs", icon: "sigma" });
    const one = (await (await app.request(`/api/sessions/${session.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ title: "Proofs" }) })).json()) as SessionJson;
    expect(one).toMatchObject({ title: "Proofs", icon: "sigma" });
  });

  it("sends no icon that isn't on the list, even if one is stored", async () => {
    const { app, db } = setup({});
    const { course, session } = await startCourse(app);
    db.update(courses).set({ icon: "<script>" }).where(eq(courses.id, course.id)).run();
    expect((await listed(app, session.id)).icon).toBeNull();
  });
});
