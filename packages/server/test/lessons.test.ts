import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { lessons as lessonsTable, runs } from "../src/db/schema.js";
import { NOTE_EXCERPTS_LABEL } from "../src/runtime/note-context.js";
import { createSessionStore } from "../src/store/session-store.js";
import { aliasingComposition } from "@mivra/protocol/test/composition-fixtures";
import { brokenReferenceExercise, sumExercise } from "@mivra/protocol/test/code-exercise-fixtures";

// Whole lessons generate through the app here, which is slow when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

type Step =
  | { toolCall: { name: string; input: unknown } }
  /** Several tool calls in one step, which the SDK runs at once. */
  | { toolCalls: { name: string; input: unknown }[] }
  | { text: string }
  | { error: string };

function scriptedModel(steps: Step[]) {
  let call = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      // Importing notes starts distilling them (ADR-014); those calls find nothing and don't use the script.
      const distilling = JSON.stringify(options.prompt).includes("Mivra distillation request");
      if (!distilling) prompts.push(JSON.stringify(options.prompt));
      const step = distilling ? { text: "" } : (steps[call++] ?? { text: "" });
      if ("error" in step) throw new Error(step.error);
      const chunks: object[] =
        "toolCalls" in step
          ? [
              ...step.toolCalls.map((c, i) => ({ type: "tool-call", toolCallId: `call_${call}_${i}`, toolName: c.name, input: JSON.stringify(c.input) })),
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : "toolCall" in step
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
  await vi.waitFor(async () => expect((await get(app, id)).lesson.status).toBe(status), { timeout: 15_000 });
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

  it("writes a code walkthrough section with show_code_walkthrough and tells the model how prediction checks work in a lesson", async () => {
    const walkthrough = {
      title: "Calling double(2)",
      code: { language: "Python", source: "def double(n):\n    return n * 2" },
      steps: [
        { explanation: "n is 2.", lines: [1], variables: [{ name: "n", value: 2 }], output: "" },
        { explanation: "It returns 4.", lines: [2], variables: [], output: "4" },
      ],
    };
    const { app, course, topics, prompts } = await setup([
      outline([{ title: "Walk", kind: "code_walkthrough" }, { title: "Check", kind: "multiple_choice" }]),
      { toolCall: { name: "show_code_walkthrough", input: walkthrough } },
      check,
      { text: "" },
    ]);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections.map((s) => [s.title, s.kind])).toEqual([["Walk", "artifact"], ["Check", "artifact"]]);
    expect(done.lesson.sections[0]!.artifact).toMatchObject({ kind: "code_walkthrough", version: 1, spec: walkthrough });
    expect(prompts[1]).toContain("with show_code_walkthrough");
    // Every section shows at once, so the prompt says a prediction's answer must not appear elsewhere in the lesson.
    expect(prompts[0]).toContain("nothing waits for the learner's answer");
    expect(prompts[0]).toContain("use a different example to illustrate");
    // A walkthrough is no check: only the multiple-choice section counts.
    expect(done.lesson.checks).toEqual({ total: 1, answered: 0 });
  });

  it("writes a composition section with show_composition, and refuses a graph in its slot", async () => {
    const graph = { title: "g", directed: true, nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] };
    const { app, course, topics, prompts } = await setup([
      outline([{ title: "Two names", kind: "composition" }, { title: "Check", kind: "multiple_choice" }]),
      { toolCall: { name: "show_graph", input: graph } },
      { toolCall: { name: "show_composition", input: aliasingComposition } },
      check,
      { text: "" },
    ]);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections.map((s) => [s.title, s.kind])).toEqual([["Two names", "artifact"], ["Check", "artifact"]]);
    expect(done.lesson.sections[0]!.artifact).toMatchObject({ kind: "composition", version: 1, spec: aliasingComposition });
    expect(prompts[0]).toContain("plan a composition section and write it with show_composition");
    expect(prompts[1]).toContain("with show_composition");
    expect(JSON.stringify(prompts)).toContain("Wrong tool for the next section");
    // Stepping through it is no check: only the multiple-choice section counts.
    expect(done.lesson.checks).toEqual({ total: 1, answered: 0 });
  });

  it("writes a code exercise section, retrying in its slot after a refused reference, and counts it as a check", async () => {
    const { app, course, topics, prompts } = await setup([
      outline([{ title: "Your turn", kind: "code_exercise" }, { title: "Check", kind: "multiple_choice" }]),
      { toolCall: { name: "ask_code_exercise", input: brokenReferenceExercise } },
      { toolCall: { name: "ask_code_exercise", input: sumExercise } },
      check,
      { text: "" },
    ]);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections.map((s) => [s.title, s.kind])).toEqual([["Your turn", "artifact"], ["Check", "artifact"]]);
    expect(done.lesson.sections[0]!.artifact).toMatchObject({ kind: "code_exercise", spec: { title: sumExercise.title } });
    expect(JSON.stringify(done.lesson)).not.toContain("referenceSolution");
    expect(JSON.stringify(prompts)).toContain("referenceSolution failed");
    expect(done.lesson.checks).toEqual({ total: 2, answered: 0 });
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

  it("fills each outline slot once when the model writes several sections in one step", async () => {
    const outlined = outline([
      { title: "First check", kind: "multiple_choice" },
      { title: "Middle", kind: "prose" },
      { title: "Last check", kind: "multiple_choice" },
    ]);
    const { app, course, topics } = await setup([
      outlined,
      // In parallel: two checks then the prose. The second check doesn't fit slot 2 and is refused.
      { toolCalls: [check.toolCall, check.toolCall, prose("Between them.").toolCall] },
      check,
      { text: "" },
    ]);
    const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
    const done = await until(app, lesson.id, "ready");
    expect(done.lesson.sections.map((s) => [s.title, s.kind])).toEqual([
      ["First check", "artifact"],
      ["Middle", "prose"],
      ["Last check", "artifact"],
    ]);
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

  describe("with imported notes", () => {
    const importVault = async (app: App, files: { path: string; text: string }[]) =>
      expect((await app.request("/api/imports", { method: "POST", headers: json, body: JSON.stringify({ name: "My vault", files }) })).status).toBe(201);
    const textOf = (content: unknown) => (typeof content === "string" ? content : (content as { text?: string }[]).map((p) => p.text ?? "").join(""));
    /** The instructions and user messages of the lesson's first model call. */
    const firstCall = (prompts: string[]) => {
      const prompt = JSON.parse(prompts[0]!) as { role: string; content: unknown }[];
      const users = prompt.filter((m) => m.role === "user").map((m) => textOf(m.content));
      return { instructions: textOf(prompt[0]!.content), users, notes: users.find((u) => u.startsWith(NOTE_EXCERPTS_LABEL)) };
    };
    const rows = (text: string | undefined, name: string) =>
      (new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text ?? "")?.[1] ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const limitsNote = { path: "Maths/Limits.md", text: "# Limits\n## One-sided\nA limit from the left can differ from the limit from the right.\n" };
    const breadNote = { path: "Cooking/Bread.md", text: "Knead the dough for ten minutes.\n" };

    it("gives the model the import list and the notes matching the lesson's topic, cited by title", async () => {
      const { app, course, topics, prompts } = await setup(basic);
      await importVault(app, [limitsNote, breadNote]);
      const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
      await until(app, lesson.id, "ready");
      const { instructions, users, notes } = firstCall(prompts);
      expect(rows(instructions, "learner_imports")).toEqual([{ import: "My vault", notes: 2 }]);
      expect(instructions).toContain("Excerpts come only for a lesson whose topic matches a note.");
      expect(instructions).toContain('cite it as their note by its title and heading, for example "your note *Recursion › Base case*"');
      expect(instructions).not.toContain("Knead");
      // Data, in a message of its own just before the lesson request; never in the trusted instructions.
      expect(users.at(-1)).toContain("Mivra lesson request");
      expect(users.at(-2)).toBe(notes);
      expect(notes).toContain("match this lesson's topic");
      expect(rows(notes, "note_excerpts")).toEqual([expect.objectContaining({ note: "Limits", path: "Maths/Limits.md", text: expect.stringContaining("A limit from the left") })]);
      expect(notes).not.toContain("Knead");
    });

    it("sends no excerpts when no note matches the topic, not even the start of a note", async () => {
      const { app, course, topics, prompts } = await setup(basic);
      await importVault(app, [breadNote, { path: "Maths/Integrals.md", text: "An integral adds up area under a curve.\n" }]);
      const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
      await until(app, lesson.id, "ready");
      const { instructions, users, notes } = firstCall(prompts);
      expect(rows(instructions, "learner_imports")).toEqual([{ import: "My vault", notes: 2 }]);
      expect(notes).toBeUndefined();
      expect(users).toHaveLength(1);
      expect(JSON.stringify(prompts)).not.toContain("Knead");
      expect(JSON.stringify(prompts)).not.toContain("area under a curve");
    });

    it("says nothing about notes to a learner who has none", async () => {
      const { app, course, topics, prompts } = await setup(basic);
      const { lesson } = (await (await start(app, course.id, topics[0]!.id)).json()) as LessonJson;
      await until(app, lesson.id, "ready");
      const { instructions, notes } = firstCall(prompts);
      expect(instructions).not.toContain("learner_imports");
      expect(instructions).not.toContain("imported notes");
      expect(notes).toBeUndefined();
    });
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
