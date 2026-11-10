import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { memoryCredentials } from "../src/credentials.js";
import { openDb, type Db } from "../src/db/client.js";
import { runs } from "../src/db/schema.js";
import type { ModelSelection } from "../src/model.js";
import type { CatalogModel } from "../src/models/catalog.js";
import { createLessonStore } from "../src/store/lesson-store.js";
import { createSessionStore } from "../src/store/session-store.js";

// Lessons generate through the whole app, which is slow when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
let callId = 0;
const toolCall = (name: string, input: unknown): object[] => [
  { type: "tool-call", toolCallId: `call_${callId++}`, toolName: name, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
];
const text = (delta: string): object[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
/** A two-section lesson: the outline, its prose and check, then done. */
const lessonSteps = [
  toolCall("outline_lesson", {
    title: "Limits",
    sections: [
      { title: "Intro", kind: "prose", purpose: "Teach it" },
      { title: "Check", kind: "multiple_choice", purpose: "Check it" },
    ],
  }),
  toolCall("write_lesson_text", { markdown: "A limit is where $f$ heads." }),
  toolCall("ask_multiple_choice", { concept: "limit", question: "Limit of $1/x$?", options: [{ text: "0" }, { text: "1" }], correctOptionIndex: 0, explanation: "It shrinks" }),
  text(""),
];

const model = (id: string, efforts: CatalogModel["reasoning"] = null): CatalogModel => ({ id, name: `Vendor: ${id}`, contextLength: 1000, price: null, reasoning: efforts });
const MAIN = model("openrouter:vendor/main", { efforts: ["low", "high"], defaultEffort: null });
const OTHER = model("openrouter:vendor/other", { efforts: ["low", "max"], defaultEffort: null });
const CHEAP = model("openrouter:vendor/cheap");

interface TaskJson {
  id: string;
  override: ModelSelection | null;
  effective: ModelSelection;
  unavailable: string | null;
}
interface LessonJson {
  lesson: { id: string; status: string; error: string | null; errorAction: string | null };
}

function setup({ db = openDb(":memory:"), catalog = [MAIN, OTHER, CHEAP], gate }: { db?: Db; catalog?: CatalogModel[]; gate?: Promise<void> } = {}) {
  const listed = { models: catalog };
  /** Every model built for a run, with the selection it was built for and how often it was called. */
  const built: { selection: ModelSelection; calls: number }[] = [];
  const app = createApp({
    db,
    model: (selection) => {
      const entry = { selection, calls: 0 };
      built.push(entry);
      return new MockLanguageModelV4({
        doStream: async () => {
          if (entry.calls === 0 && gate) await gate;
          const chunks = lessonSteps[entry.calls++] ?? text("ok");
          return { stream: simulateReadableStream({ chunks }) as never };
        },
      });
    },
    models: { defaults: { model: MAIN.id, effort: null }, catalog: { list: async () => ({ models: listed.models, state: "fresh" as const }) } },
    providers: { credentials: memoryCredentials(), isLocal: () => true },
    security: { token: "t", allowedHosts: [] },
  });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers });
  const send = async <T>(path: string, method: string, body?: unknown) => {
    const res = await call(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const task = async () => (await send<{ tasks: TaskJson[] }>("/settings/tasks", "GET")).body.tasks.find((t) => t.id === "lesson")!;
  const override = (selection: ModelSelection) => send<TaskJson & { error?: string }>("/settings/tasks/lesson", "PUT", selection);
  const reset = () => send<TaskJson>("/settings/tasks/lesson", "DELETE");
  const selectMain = (selection: ModelSelection) => send<ModelSelection>("/settings/model", "PUT", selection);
  const store = createSessionStore(db);
  /** Starts a lesson in a new course; returns its id. */
  const startLesson = async () => {
    const { course } = store.createCourse("Calculus");
    store.writeFirstSyllabus(course.id, null, { topics: [{ title: "Limits", summary: "s", reason: "r", requestedByLearner: false, concepts: ["limit"] }], known: [] });
    const topicId = store.latestSyllabus(course.id)!.topics[0]!.id;
    const res = await send<LessonJson>(`/courses/${course.id}/lessons`, "POST", { topicId });
    expect(res.status).toBe(201);
    return res.body.lesson.id;
  };
  const lesson = async (id: string) => (await send<LessonJson>(`/lessons/${id}`, "GET")).body.lesson;
  const settled = async (id: string) => {
    await vi.waitFor(async () => expect((await lesson(id)).status).not.toBe("generating"), { timeout: 15_000 });
    return lesson(id);
  };
  /** The model and effort the lesson's run recorded. */
  const provenance = (id: string) => {
    const sessionId = createLessonStore(db).findLesson(id)!.sessionId;
    return db.select({ model: runs.model, effort: runs.effort }).from(runs).where(eq(runs.sessionId, sessionId)).all();
  };
  return { db, app, built, listed, call, send, task, override, reset, selectMain, startLesson, lesson, settled, provenance };
}

describe("per-task model overrides (issue #71)", () => {
  it("uses the main model by default, following changes to it, and records it with the run", async () => {
    const t = setup();
    expect(await t.task()).toEqual({ id: "lesson", override: null, effective: { model: MAIN.id, effort: null }, unavailable: null });

    const first = await t.startLesson();
    expect((await t.settled(first)).status).toBe("ready");
    expect(t.provenance(first)).toEqual([{ model: MAIN.id, effort: null }]);

    expect((await t.selectMain({ model: OTHER.id, effort: "max" })).status).toBe(200);
    expect((await t.task()).effective).toEqual({ model: OTHER.id, effort: "max" });
    const second = await t.startLesson();
    expect((await t.settled(second)).status).toBe("ready");
    expect(t.provenance(second)).toEqual([{ model: OTHER.id, effort: "max" }]);
  });

  it("keeps an override when the main model changes, while chat keeps the main model", async () => {
    const t = setup();
    const saved = await t.override({ model: CHEAP.id, effort: null });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ id: "lesson", override: { model: CHEAP.id, effort: null }, effective: { model: CHEAP.id, effort: null }, unavailable: null });
    await t.selectMain({ model: OTHER.id, effort: "low" });
    expect((await t.task()).effective).toEqual({ model: CHEAP.id, effort: null });

    const id = await t.startLesson();
    expect((await t.settled(id)).status).toBe("ready");
    expect(t.provenance(id)).toEqual([{ model: CHEAP.id, effort: null }]);
    // The override doesn't count as using the model in the main picker.
    const picker = (await t.send<{ current: ModelSelection; recent: string[] }>("/models", "GET")).body;
    expect(picker.current).toEqual({ model: OTHER.id, effort: "low" });
    expect(picker.recent).not.toContain(CHEAP.id);

    // Chat (and so syllabus generation, which runs in a chat turn) uses the main model.
    const session = (await t.send<{ id: string }>("/sessions", "POST", {})).body;
    const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "hi" }] };
    await (await t.call(`/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message }) })).text();
    expect(t.built.at(-1)!.selection).toMatchObject({ model: OTHER.id, effort: "low" });
  });

  it("validates an override's model and effort like the main selection", async () => {
    const t = setup();
    expect((await t.override({ model: "openrouter:vendor/unknown", effort: null })).status).toBe(400);
    const effort = await t.override({ model: CHEAP.id, effort: "high" });
    expect(effort.status).toBe(400);
    expect(effort.body.error).toMatch(/doesn't support the "high" effort/);
    expect((await t.override({ model: OTHER.id, effort: "high" })).status).toBe(400);
    expect((await t.override({ model: OTHER.id, effort: "max" })).status).toBe(200);
    expect((await t.call("/settings/tasks/syllabus", { method: "PUT", body: JSON.stringify({ model: OTHER.id, effort: null }) })).status).toBe(400);
    expect((await t.task()).override).toEqual({ model: OTHER.id, effort: "max" });
  });

  it("resets to the main model, and keeps the setting across a restart", async () => {
    const db = openDb(":memory:");
    const t = setup({ db });
    await t.override({ model: CHEAP.id, effort: null });

    const restarted = setup({ db });
    expect((await restarted.task()).override).toEqual({ model: CHEAP.id, effort: null });
    const reset = await restarted.reset();
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ override: null, effective: { model: MAIN.id, effort: null } });
    // Reset means following the main model again, not a copy of it.
    await restarted.selectMain({ model: OTHER.id, effort: null });
    expect((await setup({ db }).task())).toMatchObject({ override: null, effective: { model: OTHER.id, effort: null } });
  });

  it("keeps a running job's model when the override changes, and uses the new one for the next job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup({ gate });
    await t.override({ model: CHEAP.id, effort: null });
    const running = await t.startLesson();
    await vi.waitFor(() => expect(t.built).toHaveLength(1));

    await t.override({ model: OTHER.id, effort: "low" });
    await t.selectMain({ model: OTHER.id, effort: "high" });
    release();
    expect((await t.settled(running)).status).toBe("ready");
    // Every step of the job went to the model it started with.
    expect(t.built).toHaveLength(1);
    expect(t.built[0]!.selection).toMatchObject({ model: CHEAP.id, effort: null });
    expect(t.built[0]!.calls).toBe(lessonSteps.length);
    expect(t.provenance(running)).toEqual([{ model: CHEAP.id, effort: null }]);

    const next = await t.startLesson();
    expect((await t.settled(next)).status).toBe("ready");
    expect(t.provenance(next)).toEqual([{ model: OTHER.id, effort: "low" }]);
  });

  it("fails a lesson whose override left the catalog, without calling another model, until the learner fixes it", async () => {
    const t = setup();
    await t.override({ model: CHEAP.id, effort: null });
    t.listed.models = [MAIN, OTHER];
    const view = await t.task();
    expect(view.unavailable).toMatch(/isn't in the list of models/);

    const id = await t.startLesson();
    const failed = await t.settled(id);
    expect(failed).toMatchObject({ status: "failed", errorAction: "lesson-model" });
    expect(failed.error).toMatch(/model chosen for lessons in Settings \(openrouter:vendor\/cheap\) can't be used/);
    expect(failed.error).toMatch(/Use main model/);
    expect(t.built).toEqual([]);
    expect(t.provenance(id)).toEqual([]);

    // An effort the model no longer offers is caught too.
    await t.override({ model: OTHER.id, effort: "max" });
    t.listed.models = [MAIN, { ...OTHER, reasoning: { efforts: ["low"], defaultEffort: null } }];
    expect((await t.task()).unavailable).toMatch(/no longer offers the "max" effort/);

    // Resetting to the main model lets the lesson carry on.
    await t.reset();
    expect((await t.call(`/lessons/${id}/retry`, { method: "POST" })).status).toBe(202);
    const resumed = await t.settled(id);
    expect(resumed).toMatchObject({ status: "ready", errorAction: null, error: null });
    expect(t.provenance(id)).toEqual([{ model: MAIN.id, effort: null }]);
  });

  it("fails a lesson whose override's custom provider was removed, with the provider's own reason", async () => {
    const t = setup();
    const created = await t.send<{ custom: { id: string }[] }>("/settings/providers/custom", "POST", {
      name: "Local",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "small" }],
    });
    expect(created.status).toBe(201);
    const providerId = created.body.custom[0]!.id;
    const custom = `custom:${providerId}/small`;
    expect((await t.override({ model: custom, effort: null })).status).toBe(200);
    expect((await t.call(`/settings/providers/custom/${providerId}`, { method: "DELETE" })).status).toBe(200);

    const view = await t.task();
    expect(view.unavailable).toBe("The provider Local was removed.");
    const id = await t.startLesson();
    const failed = await t.settled(id);
    expect(failed).toMatchObject({ status: "failed", errorAction: "lesson-model" });
    expect(failed.error).toContain("The provider Local was removed.");
    expect(failed.error).not.toContain("picker under the message box");
    expect(t.built).toEqual([]);
  });
});
