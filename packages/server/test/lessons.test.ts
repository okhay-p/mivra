import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { lessons as lessonsTable, runs } from "../src/db/schema.js";
import { createSessionStore } from "../src/store/session-store.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

type Step = { toolCall: { name: string; input: unknown } } | { text: string } | { error: string };

function scriptedModel(steps: Step[]) {
  let call = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const step = steps[call++] ?? { text: "" };
      if ("error" in step) throw new Error(step.error);
      const chunks: object[] =
        "toolCall" in step
          ? [
              { type: "tool-call", toolCallId: `call_${call}`, toolName: step.toolCall.name, input: JSON.stringify(step.toolCall.input) },
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
  return { model, prompts };
}

const outline = (sections: { title: string; kind: string }[]) => ({
  toolCall: { name: "outline_lesson", input: { title: "Limits", sections: sections.map((s) => ({ ...s, purpose: `Teach ${s.title}` })) } },
});
const prose = (markdown: string) => ({ toolCall: { name: "write_lesson_text", input: { markdown } } });
const check = {
  toolCall: {
    name: "ask_multiple_choice",
    input: {
      concept: "limit",
      question: "What is the limit of $1/x$ as $x$ grows?",
      options: [{ text: "0" }, { text: "1" }],
      correctOptionIndex: 0,
      explanation: "SECRET-EXPLANATION it shrinks",
    },
  },
};
const basic = [outline([{ title: "Intro", kind: "prose" }, { title: "Check", kind: "multiple_choice" }]), prose("A **limit** is where $f$ heads."), check, { text: "" }];

async function setup(steps: Step[]) {
  const db = openDb(":memory:");
  const scripted = scriptedModel(steps);
  const app = createApp({ db, model: () => scripted.model, security: { token: TOKEN, allowedHosts: [] } });
  const store = createSessionStore(db);
  const { course } = store.createCourse("Calculus");
  store.writeFirstSyllabus(course.id, null, {
    topics: [
      { title: "Limits", summary: "s", reason: "r", requestedByLearner: false, concepts: ["limit"] },
      { title: "Derivatives", summary: "s", reason: "r", requestedByLearner: false, concepts: ["derivative"] },
    ],
    known: [],
  });
  const topics = store.latestSyllabus(course.id)!.topics;
  return { app, db, course, topics, prompts: scripted.prompts };
}
type App = Awaited<ReturnType<typeof setup>>["app"];

interface LessonJson {
  lesson: {
    id: string;
    status: string;
    sections: { kind: string; title: string; markdown?: string; artifact?: { id: string; spec: object } }[];
    checks: { total: number; answered: number };
    canFinish: boolean;
    outline: { sections: object[] } | null;
  };
  revision: string;
}

const start = async (app: App, courseId: string, topicId: string) =>
  app.request(`/api/courses/${courseId}/lessons`, { method: "POST", headers: json, body: JSON.stringify({ topicId }) });
const get = async (app: App, id: string, after?: string) =>
  (await (await app.request(`/api/lessons/${id}${after ? `?after=${encodeURIComponent(after)}` : ""}`, { headers: auth })).json()) as LessonJson;
const until = async (app: App, id: string, status: string) => {
  await vi.waitFor(async () => expect((await get(app, id)).lesson.status).toBe(status), { timeout: 5000 });
  return get(app, id);
};
const answer = (app: App, artifactId: string, optionIndex: number) =>
  app.request(`/api/artifacts/${artifactId}/attempts`, { method: "POST", headers: json, body: JSON.stringify({ answer: { optionIndex } }) });

describe("lessons", () => {
  it("writes the outline, then one section per call, without leaking the answer key", async () => {
    const { app, course, topics } = await setup(basic);
    const res = await start(app, course.id, topics[0]!.id);
    expect(res.status).toBe(201);
    const { lesson } = (await res.json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections.map((s) => [s.title, s.kind])).toEqual([["Intro", "prose"], ["Check", "artifact"]]);
    expect(done.lesson.sections[0]!.markdown).toContain("**limit**");
    expect(JSON.stringify(done)).not.toContain("SECRET-EXPLANATION");
    expect(JSON.stringify(done)).not.toContain("correctOptionIndex");
    expect(done.lesson.checks).toEqual({ total: 1, answered: 0 });
    expect(done.lesson.canFinish).toBe(false);
  });

  it("is written just in time: the next topic waits until the earlier lesson is finished", async () => {
    const { app, course, topics } = await setup([...basic, ...basic]);
    expect((await start(app, course.id, topics[1]!.id)).status).toBe(409);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    // Starting the same topic again returns the same lesson.
    expect(((await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson).lesson.id).toBe(lesson.id);
    const done = await until(app, lesson.id, "ready");
    expect((await start(app, course.id, topics[1]!.id)).status).toBe(409);

    expect((await app.request(`/api/lessons/${lesson.id}/finish`, { method: "POST", headers: auth })).status).toBe(409);
    // A wrong answer still lets the learner finish: scores never block moving on.
    expect((await answer(app, done.lesson.sections[1]!.artifact!.id, 1)).status).toBe(201);
    const finished = await app.request(`/api/lessons/${lesson.id}/finish`, { method: "POST", headers: auth });
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as LessonJson).lesson.status).toBe("finished");

    const list = (await (await app.request(`/api/courses/${course.id}/lessons`, { headers: auth })).json()) as { nextTopicId: string; currentLessonId: string };
    expect(list.nextTopicId).toBe(topics[1]!.id);
    expect(list.currentLessonId).toBe(lesson.id);
    expect((await start(app, course.id, topics[1]!.id)).status).toBe(201);
  });

  it("doesn't continue a chat after a lesson check, and hides lesson sessions from the session list", async () => {
    const { app, db, course, topics } = await setup(basic);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    await answer(app, done.lesson.sections[1]!.artifact!.id, 0);
    await new Promise((r) => setTimeout(r, 100));
    const lessonRuns = db.select().from(runs).all().filter((r) => r.continuationOf);
    expect(lessonRuns).toEqual([]);
    const sessions = (await (await app.request("/api/sessions", { headers: auth })).json()) as { title: string }[];
    expect(sessions.map((s) => s.title)).toEqual(["Calculus"]);
  });

  it("refuses a section written with the wrong tool and lets the model repair it", async () => {
    const { app, course, topics } = await setup([check, ...basic]);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections.map((s) => s.title)).toEqual(["Intro", "Check"]);
  });

  it("has its own step budget, beyond a chat turn's five steps", async () => {
    const kinds = [
      { title: "One", kind: "prose" },
      { title: "Two", kind: "prose" },
      { title: "Three", kind: "prose" },
      { title: "Four", kind: "prose" },
      { title: "Five", kind: "prose" },
      { title: "Six", kind: "prose" },
      { title: "Check", kind: "multiple_choice" },
    ];
    const { app, course, topics } = await setup([outline(kinds), ...kinds.slice(0, 6).map((k) => prose(k.title)), check, { text: "" }]);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections).toHaveLength(7);
  });

  it("keeps written sections when generation fails, and resumes from there on retry", async () => {
    const { app, course, topics, prompts } = await setup([
      outline([{ title: "Intro", kind: "prose" }, { title: "Check", kind: "multiple_choice" }]),
      prose("Part one."),
      { error: "provider down" },
      check,
      { text: "" },
    ]);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const failed = await until(app, lesson.id, "failed");
    expect(failed.lesson.sections.map((s) => s.title)).toEqual(["Intro"]);
    const retry = await app.request(`/api/lessons/${lesson.id}/retry`, { method: "POST", headers: auth });
    expect(retry.status).toBe(202);
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections.map((s) => s.title)).toEqual(["Intro", "Check"]);
    expect(prompts.at(-2)).toContain("resuming");
    expect((await app.request(`/api/lessons/${lesson.id}/retry`, { method: "POST", headers: auth })).status).toBe(409);
  });

  it("lets a client wait for the next change", async () => {
    const { app, course, topics } = await setup(basic);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const ready = await until(app, lesson.id, "ready");
    const waiting = get(app, lesson.id, ready.revision);
    let settled = false;
    void waiting.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    await answer(app, ready.lesson.sections[1]!.artifact!.id, 0);
    const next = await waiting;
    expect(next.revision).not.toBe(ready.revision);
    expect(next.lesson.checks.answered).toBe(1);
  });

  it("returns 404s for unknown courses, topics and lessons", async () => {
    const { app, course } = await setup([]);
    expect((await app.request(`/api/courses/nope/lessons`, { headers: auth })).status).toBe(404);
    expect((await start(app, course.id, "nope")).status).toBe(404);
    expect((await app.request(`/api/lessons/nope`, { headers: auth })).status).toBe(404);
  });

  it("recovers a lesson left generating by a stopped server as failed, so it can be resumed", async () => {
    const { app, db, course, topics } = await setup(basic);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    await until(app, lesson.id, "ready");
    // Stand in for a server that stopped mid-generation.
    db.update(lessonsTable).set({ status: "generating" }).where(eq(lessonsTable.id, lesson.id)).run();
    const restarted = createApp({ db, model: () => scriptedModel([]).model, security: { token: TOKEN, allowedHosts: [] } });
    expect((await get(restarted, lesson.id)).lesson.status).toBe("failed");
  });
});
