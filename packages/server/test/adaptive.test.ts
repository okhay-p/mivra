import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { createSessionStore } from "../src/store/session-store.js";

// Whole lessons generate through the app here, which is slow when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

type Step = { toolCall: { name: string; input: unknown } } | { text: string };

function scriptedModel(steps: Step[]) {
  let call = 0;
  const calls: { tools: string[]; system: string }[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push({ tools: (options.tools ?? []).map((t) => t.name), system: JSON.stringify(options.prompt.filter((m) => m.role === "system")) });
      const step = steps[call++] ?? { text: "" };
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
  return { model, calls };
}

const mc = (concept: string) => ({
  toolCall: {
    name: "ask_multiple_choice",
    input: { concept, question: `What about ${concept}?`, options: [{ text: "Right" }, { text: "Wrong" }], correctOptionIndex: 0, explanation: "Because." },
  },
});
const outline = (title: string, kinds: string[]) => ({
  toolCall: { name: "outline_lesson", input: { title, sections: kinds.map((kind, i) => ({ title: `${title} ${i + 1}`, kind, purpose: "p" })) } },
});
const prose = (markdown: string, revisits?: string[]) => ({ toolCall: { name: "write_lesson_text", input: { markdown, ...(revisits ? { revisits } : {}) } } });
/** A lesson: prose, then two checks. */
const lessonSteps = (title: string): Step[] => [outline(title, ["prose", "multiple_choice", "multiple_choice"]), prose(`${title} text`), mc(`${title} a`), mc(`${title} b`), { text: "" }];

interface LessonJson {
  lesson: {
    id: string;
    status: string;
    sections: { id: string; kind: string; title: string; revisits?: { lessonId: string; sectionId: string; title: string; lessonTitle: string }[]; artifact?: { id: string } }[];
  };
}
interface CourseJson {
  id: string;
  status: string;
  syllabus: { version: number; source: string; reason: string | null; canUndo: boolean; changedTopicIds: string[]; topics: { id: string; title: string }[] };
}

async function setup(topicTitles = ["Limits", "Derivatives", "Integrals"]) {
  const db = openDb(":memory:");
  const steps: Step[] = [];
  const { model, calls } = scriptedModel(steps);
  const app = createApp({ db, model: () => model, security: { token: TOKEN, allowedHosts: [] } });
  const store = createSessionStore(db);
  const { course, session } = store.createCourse("Calculus");
  store.writeFirstSyllabus(course.id, null, {
    topics: topicTitles.map((title) => ({ title, summary: "s", reason: "r", requestedByLearner: title === "Integrals", concepts: [title.toLowerCase()] })),
    known: [],
  });
  const courseJson = async () => (await (await app.request(`/api/sessions/${session.id}/course`, { headers: auth })).json()) as CourseJson;
  const lesson = async (id: string) => (await (await app.request(`/api/lessons/${id}`, { headers: auth })).json()) as LessonJson;
  const ready = async (id: string) => {
    await vi.waitFor(async () => expect((await lesson(id)).lesson.status).toBe("ready"), { timeout: 15_000 });
    return (await lesson(id)).lesson;
  };
  const start = async (topicId: string) =>
    ((await (await app.request(`/api/courses/${course.id}/lessons`, { method: "POST", headers: json, body: JSON.stringify({ topicId }) })).json()) as LessonJson).lesson.id;
  /** Answers every check, right or wrong, then finishes the lesson. */
  const finish = async (id: string, wrong: number) => {
    const checks = (await lesson(id)).lesson.sections.filter((s) => s.artifact);
    for (const [i, s] of checks.entries()) {
      await app.request(`/api/artifacts/${s.artifact!.id}/attempts`, { method: "POST", headers: json, body: JSON.stringify({ answer: { optionIndex: i < wrong ? 1 : 0 } }) });
    }
    expect((await app.request(`/api/lessons/${id}/finish`, { method: "POST", headers: auth })).status).toBe(200);
  };
  return { app, store, course, steps, calls, courseJson, lesson, ready, start, finish };
}

describe("evidence-driven next lessons", () => {
  it("gives the next lesson the previous one's sections and mistakes, and links back to them", async () => {
    const t = await setup();
    t.steps.push(...lessonSteps("Limits"));
    const topics = (await t.courseJson()).syllabus.topics;
    const first = await t.start(topics[0]!.id);
    const firstLesson = await t.ready(first);
    await t.finish(first, 1);

    const taught = firstLesson.sections[0]!.id;
    t.steps.push(
      outline("Derivatives", ["prose", "multiple_choice"]),
      prose("Revisit.", ["not-a-section"]),
      prose("Last time you mixed up limits.", [taught]),
      mc("derivative"),
      { text: "" },
    );
    const second = await t.start(topics[1]!.id);
    const secondLesson = await t.ready(second);
    const system = t.calls.at(-1)!.system;
    expect(system).toContain("previous_lesson");
    expect(system).toContain(taught);
    expect(system).toContain("missed");
    expect(system).toContain("learnerChose");
    // One miss of two checks is half: the learner struggled, so the plan may adapt.
    expect(t.calls.at(-1)!.tools).toContain("adapt_syllabus");
    expect(secondLesson.sections[0]!.revisits).toEqual([{ lessonId: first, sectionId: taught, title: "Limits 1", lessonTitle: "Limits" }]);
  });

  it("doesn't offer to adapt the plan when the learner did well, and says not to recap", async () => {
    const t = await setup();
    t.steps.push(...lessonSteps("Limits"));
    const topics = (await t.courseJson()).syllabus.topics;
    const first = await t.start(topics[0]!.id);
    await t.ready(first);
    await t.finish(first, 0);
    t.steps.push(outline("Derivatives", ["prose", "multiple_choice"]), prose("On we go."), mc("derivative"), { text: "" });
    await t.ready(await t.start(topics[1]!.id));
    expect(t.calls.at(-1)!.tools).not.toContain("adapt_syllabus");
    expect(t.calls.at(-1)!.system).toContain("don't recap");
  });
});

describe("automatic syllabus changes", () => {
  async function struggled() {
    const t = await setup();
    t.steps.push(...lessonSteps("Limits"));
    const topics = (await t.courseJson()).syllabus.topics;
    const first = await t.start(topics[0]!.id);
    await t.ready(first);
    await t.finish(first, 2);
    return { ...t, topics, first };
  }

  it("changes future topics once per finished lesson, with its reason, and the learner can undo it", async () => {
    const t = await struggled();
    const refresher = { op: "insert", afterTopicId: null, title: "Limits refresher", summary: "Again, slowly.", concepts: ["limit"] };
    t.steps.push(
      { toolCall: { name: "adapt_syllabus", input: { reason: "Added a refresher: you missed 2 of 2 checks on limits", operation: refresher } } },
      { toolCall: { name: "adapt_syllabus", input: { reason: "Again", operation: { ...refresher, title: "Second refresher" } } } },
      outline("Derivatives", ["prose", "multiple_choice"]),
      prose("x"),
      mc("derivative"),
      { text: "" },
    );
    await t.ready(await t.start(t.topics[1]!.id));
    const changed = await t.courseJson();
    expect(changed.syllabus.version).toBe(2);
    expect(changed.syllabus.source).toBe("adaptive");
    expect(changed.syllabus.reason).toBe("Added a refresher: you missed 2 of 2 checks on limits");
    expect(changed.syllabus.topics.map((x) => x.title)).toEqual(["Limits", "Derivatives", "Limits refresher", "Integrals"]);
    expect(changed.syllabus.canUndo).toBe(true);

    const undo = await t.app.request(`/api/courses/${t.course.id}/syllabus/undo`, { method: "POST", headers: json, body: JSON.stringify({ version: 2 }) });
    expect(undo.status).toBe(200);
    const restored = (await undo.json()) as CourseJson;
    expect(restored.syllabus.version).toBe(3);
    expect(restored.syllabus.source).toBe("undo");
    expect(restored.syllabus.topics.map((x) => x.title)).toEqual(["Limits", "Derivatives", "Integrals"]);
    expect(restored.syllabus.canUndo).toBe(false);
    expect((await t.app.request(`/api/courses/${t.course.id}/syllabus/undo`, { method: "POST", headers: json, body: JSON.stringify({ version: 3 }) })).status).toBe(409);
  });

  it("never touches started topics, and splits keep a requested topic requested", async () => {
    const t = await struggled();
    t.steps.push(
      { toolCall: { name: "adapt_syllabus", input: { reason: "Too early", operation: { op: "move", topicId: t.topics[0]!.id, afterTopicId: null } } } },
      {
        toolCall: {
          name: "adapt_syllabus",
          input: {
            reason: "Integrals is big: split it",
            operation: {
              op: "split",
              topicId: t.topics[2]!.id,
              into: [
                { title: "Area", summary: "s", concepts: ["area"] },
                { title: "Antiderivatives", summary: "s", concepts: ["antiderivative"] },
              ],
            },
          },
        },
      },
      outline("Derivatives", ["prose", "multiple_choice"]),
      prose("x"),
      mc("derivative"),
      { text: "" },
    );
    await t.ready(await t.start(t.topics[1]!.id));
    const course = await t.courseJson();
    expect(course.syllabus.version).toBe(2);
    expect(course.syllabus.topics.map((x) => x.title)).toEqual(["Limits", "Derivatives", "Area", "Antiderivatives"]);
    const store = t.store.latestSyllabus(t.course.id)!;
    expect(store.topics.filter((x) => x.requestedByLearner).map((x) => x.title)).toEqual(["Area", "Antiderivatives"]);
  });

  it("can't undo once a lesson from the change has started", async () => {
    const t = await struggled();
    t.steps.push(
      { toolCall: { name: "adapt_syllabus", input: { reason: "Refresher", operation: { op: "insert", afterTopicId: null, title: "Refresher", summary: "s", concepts: ["limit"] } } } },
      outline("Derivatives", ["prose", "multiple_choice"]),
      prose("x"),
      mc("derivative"),
      { text: "" },
      ...lessonSteps("Refresher"),
    );
    const second = await t.start(t.topics[1]!.id);
    await t.ready(second);
    await t.finish(second, 0);
    const refresher = (await t.courseJson()).syllabus.topics[2]!;
    await t.ready(await t.start(refresher.id));
    expect((await t.courseJson()).syllabus.canUndo).toBe(false);
    expect((await t.app.request(`/api/courses/${t.course.id}/syllabus/undo`, { method: "POST", headers: json, body: JSON.stringify({ version: 2 }) })).status).toBe(409);
  });
});

describe("course completion", () => {
  it("completes the course when the learner finishes the last topic", async () => {
    const t = await setup(["Limits", "Derivatives"]);
    t.steps.push(...lessonSteps("Limits"), ...lessonSteps("Derivatives"));
    const topics = (await t.courseJson()).syllabus.topics;
    const first = await t.start(topics[0]!.id);
    await t.ready(first);
    await t.finish(first, 0);
    expect((await t.courseJson()).status).toBe("active");
    const second = await t.start(topics[1]!.id);
    await t.ready(second);
    await t.finish(second, 2);
    expect((await t.courseJson()).status).toBe("complete");
  });
});
