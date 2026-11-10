import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { createSessionStore } from "../src/store/session-store.js";

// Lessons generate through the app here, which is slow when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** A step of the scripted model: a tool call, some text, or a stream that stays open until it is aborted. */
type Step = { tool: string; input: unknown } | { text: string } | "hang";

function scriptedModel(steps: Step[]) {
  let call = 0;
  let opened!: () => void;
  const hanging = new Promise<void>((resolve) => (opened = resolve));
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const step = steps[call++] ?? { text: "done" };
      if (step === "hang") {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: "partial" });
            abortSignal?.addEventListener("abort", () => {
              try {
                c.error(new DOMException("Aborted", "AbortError"));
              } catch {
                // Already closed.
              }
            });
            opened();
          },
        });
        return { stream };
      }
      const chunks: object[] =
        "tool" in step
          ? [
              { type: "tool-call", toolCallId: `call_${call}`, toolName: step.tool, input: JSON.stringify(step.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
  return { model, hanging };
}

function setup(steps: Step[]) {
  const db = openDb(":memory:");
  const scripted = scriptedModel(steps);
  const app = createApp({ db, model: () => scripted.model, security: { token: TOKEN, allowedHosts: [] } });
  return { app, db, store: createSessionStore(db), hanging: scripted.hanging };
}
type App = ReturnType<typeof setup>["app"];

const remove = (app: App, id: string) => app.request(`/api/sessions/${id}`, { method: "DELETE", headers: auth });
const chat = (app: App, sessionId: string, text: string, lessonId?: string) =>
  app.request(`/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ message: { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }, ...(lessonId ? { lessonId } : {}) }),
  });
const listed = async (app: App) => ((await (await app.request("/api/sessions", { headers: auth })).json()) as { id: string }[]).map((s) => s.id);

const tables = ["sessions", "messages", "runs", "artifacts", "attempts", "documents", "document_chunks", "courses", "syllabus_versions", "lessons", "lesson_sections", "lesson_versions"];
/** Row counts of every table a session owns, keyed by table. */
const counts = (db: Db) => Object.fromEntries(tables.map((t) => [t, db.get<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${t}`))!.n]));
const empty = Object.fromEntries(tables.map((t) => [t, 0]));

const goal = { kind: "goal", text: "Pass the exam" };
const check = {
  tool: "ask_multiple_choice",
  input: { concept: "limit", question: "Limit of 1/x?", options: [{ text: "0" }, { text: "1" }], correctOptionIndex: 0, explanation: "It shrinks" },
};
const outline = {
  tool: "outline_lesson",
  input: { title: "Limits", sections: [{ title: "Intro", kind: "prose", purpose: "p" }, { title: "Check", kind: "multiple_choice", purpose: "p" }] },
};

/** A course with a syllabus and one lesson started, which the model then writes (or hangs while writing). */
async function startCourseWithLesson(app: App, store: ReturnType<typeof createSessionStore>) {
  const { course } = store.createCourse("Calculus");
  store.writeFirstSyllabus(course.id, null, {
    topics: [{ title: "Limits", summary: "s", reason: "r", requestedByLearner: false, concepts: ["limit"] }],
    known: [],
  });
  const topicId = store.latestSyllabus(course.id)!.topics[0]!.id;
  const res = await app.request(`/api/courses/${course.id}/lessons`, { method: "POST", headers: json, body: JSON.stringify({ topicId }) });
  expect(res.status).toBe(201);
  const { lesson } = (await res.json()) as { lesson: { id: string } };
  return { course, lessonId: lesson.id };
}
const lessonStatus = async (app: App, id: string) => {
  const res = await app.request(`/api/lessons/${id}`, { headers: auth });
  return res.status === 200 ? ((await res.json()) as { lesson: { status: string; sections: { artifact?: { id: string } }[] } }).lesson : res.status;
};

describe("deleting a session", () => {
  it("returns 404 for an unknown session", async () => {
    const { app } = setup([]);
    expect((await remove(app, "nope")).status).toBe(404);
  });

  it("removes a chat with its messages, runs, artifacts, attempts and documents, keeping its memories", async () => {
    const { app, db, store } = setup([{ tool: "remember", input: goal }, check, { text: "Try it." }]);
    const keep = store.createSession("Keep me");
    const session = store.createSession("Delete me");
    store.createDocument({ sessionId: session.id, filename: "notes.pdf", kind: "pdf", byteSize: 1, textChars: 9, pageCount: 1, pagesWithText: 1 }, [{ page: 1, seq: 0, text: "zebrafish anatomy" }], 5);
    await (await chat(app, session.id, "Teach me limits")).text();
    const artifactId = db.get<{ id: string }>(sql`SELECT id FROM artifacts`)!.id;
    expect((await app.request(`/api/artifacts/${artifactId}/attempts`, { method: "POST", headers: json, body: JSON.stringify({ answer: { optionIndex: 0 } }) })).status).toBe(201);
    await vi.waitFor(() => expect(db.get<{ n: number }>(sql`SELECT count(*) AS n FROM runs WHERE status = 'running'`)!.n).toBe(0));
    expect(counts(db).attempts).toBe(1);

    expect((await remove(app, session.id)).status).toBe(204);
    expect(await listed(app)).toEqual([keep.id]);
    expect(counts(db)).toEqual({ ...empty, sessions: 1 });
    // The search index forgets the document's text too.
    expect(db.all(sql`SELECT rowid FROM document_chunks_fts WHERE document_chunks_fts MATCH 'zebrafish'`)).toEqual([]);
    // Memories describe the learner, not the session.
    expect(db.all(sql`SELECT text, session_id AS sessionId, status FROM memories`)).toEqual([{ text: goal.text, sessionId: null, status: "active" }]);
    expect((await remove(app, session.id)).status).toBe(404);
  });

  it("removes a course with its syllabus, lessons, and every lesson's session, messages and artifacts", async () => {
    const { app, db, store } = setup([outline, { tool: "write_lesson_text", input: { markdown: "A limit." } }, check, { text: "" }, { text: "Lesson chat reply" }]);
    const keep = store.createSession("Keep me");
    const { course, lessonId } = await startCourseWithLesson(app, store);
    await vi.waitFor(async () => expect(await lessonStatus(app, lessonId)).toMatchObject({ status: "ready" }), { timeout: 15_000 });
    const lessonSession = db.get<{ id: string }>(sql`SELECT session_id AS id FROM lessons`)!.id;
    // The lesson's own chat, and an answer to its check.
    await (await chat(app, lessonSession, "Why?")).text();
    const lesson = await lessonStatus(app, lessonId);
    const artifactId = (lesson as Exclude<typeof lesson, number>).sections.find((s) => s.artifact)!.artifact!.id;
    expect((await app.request(`/api/artifacts/${artifactId}/attempts`, { method: "POST", headers: json, body: JSON.stringify({ answer: { optionIndex: 1 } }) })).status).toBe(201);
    expect(counts(db)).toMatchObject({ sessions: 3, lessons: 1, lesson_sections: 2, artifacts: 1, attempts: 1, syllabus_versions: 1 });

    // A lesson's chat goes with its course, not on its own.
    expect((await remove(app, lessonSession)).status).toBe(409);
    expect((await remove(app, course.sessionId)).status).toBe(204);
    expect(await listed(app)).toEqual([keep.id]);
    expect(counts(db)).toEqual({ ...empty, sessions: 1 });
    expect(await lessonStatus(app, lessonId)).toBe(404);
  });

  it("stops a reply in progress first, so its ending writes nothing, and drops memories it hadn't confirmed", async () => {
    const { app, db, store, hanging } = setup([{ tool: "remember", input: goal }, "hang"]);
    const session = store.createSession();
    const res = await chat(app, session.id, "Explain limits");
    const body = res.text();
    await hanging;
    expect(db.get<{ status: string }>(sql`SELECT status FROM memories`)?.status).toBe("pending");

    expect((await remove(app, session.id)).status).toBe(204);
    await body;
    // Give the cancelled run's ending time to (not) record anything.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts(db)).toEqual(empty);
    expect(db.all(sql`SELECT id FROM memories`)).toEqual([]);
  });

  it("stops a lesson being written before deleting its course, leaving no orphan rows", async () => {
    const { app, db, store, hanging } = setup([outline, "hang"]);
    const { course, lessonId } = await startCourseWithLesson(app, store);
    await hanging;
    expect(await lessonStatus(app, lessonId)).toMatchObject({ status: "generating" });

    const waiting = app.request(`/api/lessons/${lessonId}?after=x`, { headers: auth });
    expect((await remove(app, course.sessionId)).status).toBe(204);
    expect((await waiting).status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts(db)).toEqual(empty);
  });
});
