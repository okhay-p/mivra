import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ExerciseCaseRun, MilestoneCases, MilestoneCheckResult, ProjectMilestoneInput } from "@mivra/protocol";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { prepareProjectMilestone, runCasesInChild, type RunCases } from "../src/exercises/reference-check.js";
import { coreCourse } from "../src/plugins/core-course.js";
import { createCoreLearning } from "../src/plugins/core-learning.js";
import { coreMemory } from "../src/plugins/core-memory.js";
import { createSessionStore } from "../src/store/session-store.js";

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

type Step = { toolCall: { name: string; input: unknown } } | { text: string };

function scriptedModel(steps: Step[]) {
  let call = 0;
  const prompts: string[] = [];
  const tools: string[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      tools.push((options.tools ?? []).map((t) => t.name));
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
  return { model, prompts, tools };
}

/** Counts tokens: a stand-in for a learner's tokenizer milestone. */
const milestone: ProjectMilestoneInput = {
  concept: "tokenizing",
  title: "Count the tokens",
  spec: "Read an expression on stdin and print how many tokens it has.",
  outputFormat: "One line: `tokens: N`.",
  checkType: "tests",
  cases: [
    { name: "one number", input: "42" },
    { name: "a sum", input: "1 + 2" },
  ],
  referenceSolution: "import sys\nprint(f'tokens: {len(sys.stdin.read().split())}')\n",
};

/** Pretends to run the Python reference, so these tests don't start Pyodide: it counts words, as the reference does. */
const fakeReference: RunCases = async ({ code, cases }) =>
  cases.map((c): ExerciseCaseRun => (code.includes("BROKEN") ? { stdout: "", error: "NameError: BROKEN" } : { stdout: `tokens: ${("stdin" in c ? c.stdin : "").split(/\s+/).filter(Boolean).length}\n` }));

const outline = (sections: { title: string; kind: string }[]) => ({
  toolCall: { name: "outline_lesson", input: { title: "Tokens", sections: sections.map((s) => ({ ...s, purpose: `Teach ${s.title}` })) } },
});
const lessonSteps: Step[] = [
  outline([{ title: "What a token is", kind: "prose" }, { title: "Build it", kind: "project_milestone" }]),
  { toolCall: { name: "write_lesson_text", input: { markdown: "A token is the smallest unit a parser sees." } } },
  { toolCall: { name: "set_project_milestone", input: { ...milestone, referenceSolution: "BROKEN" } } },
  { toolCall: { name: "set_project_milestone", input: milestone } },
  { text: "" },
];

function setup(steps: Step[], kind: "lessons" | "project" = "project") {
  const db = openDb(":memory:");
  const scripted = scriptedModel(steps);
  const app = createApp({
    db,
    model: () => scripted.model,
    security: { token: TOKEN, allowedHosts: [] },
    plugins: [createCoreLearning({ runCases: fakeReference }), coreMemory, coreCourse],
  });
  const store = createSessionStore(db);
  const { course } = store.createCourse("A calculator in Rust", kind);
  store.writeFirstSyllabus(course.id, null, {
    topics: [
      { title: "Tokens", summary: "s", reason: "r", requestedByLearner: false, concepts: ["tokenizing"] },
      { title: "Parsing", summary: "s", reason: "r", requestedByLearner: false, concepts: ["parsing"] },
    ],
    known: [],
  });
  return { app, store, course, topics: store.latestSyllabus(course.id)!.topics, ...scripted };
}
type App = ReturnType<typeof setup>["app"];

interface LessonJson {
  lesson: { id: string; status: string; sections: { kind: string; artifact?: { id: string; kind: string; spec: object; latestAttempt?: { grade: { passed: number } } } }[]; checks: { total: number; answered: number }; canFinish: boolean };
  revision: string;
}
const getLesson = async (app: App, id: string) => (await (await app.request(`/api/lessons/${id}`, { headers: auth })).json()) as LessonJson;
const startLesson = async (app: App, courseId: string, topicId: string) =>
  ((await (await app.request(`/api/courses/${courseId}/lessons`, { method: "POST", headers: json, body: JSON.stringify({ topicId }) })).json()) as LessonJson).lesson;
const ready = async (app: App, id: string) => {
  await vi.waitFor(async () => expect((await getLesson(app, id)).lesson.status).toBe("ready"), { timeout: 15_000 });
  return getLesson(app, id);
};
const milestoneOf = (app: App, courseId: string) => app.request(`/api/courses/${courseId}/milestone`, { headers: auth });
const check = (app: App, artifactId: string, stdouts: string[], exitCode = 0) =>
  app.request(`/api/artifacts/${artifactId}/checks`, { method: "POST", headers: json, body: JSON.stringify({ results: stdouts.map((stdout) => ({ stdout, exitCode })) }) });

describe("project courses", () => {
  it("starts as a project course and says so", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, model: () => scriptedModel([]).model, security: { token: TOKEN, allowedHosts: [] } });
    const res = await app.request("/api/courses", { method: "POST", headers: json, body: JSON.stringify({ goal: "A C compiler", kind: "project" }) });
    const { course } = (await res.json()) as { course: { id: string; kind: string } };
    expect(course.kind).toBe("project");
    const byId = (await (await app.request(`/api/courses/${course.id}`, { headers: auth })).json()) as { kind: string; goal: string };
    expect(byId).toMatchObject({ kind: "project", goal: "A C compiler" });
    expect((await app.request("/api/courses/nope", { headers: auth })).status).toBe(404);
    const plain = (await (await app.request("/api/courses", { method: "POST", headers: json, body: JSON.stringify({ goal: "Calculus" }) })).json()) as { course: { kind: string } };
    expect(plain.course.kind).toBe("lessons");
  });

  it("writes a milestone lesson, retrying after a failed reference, and keeps the reference private", async () => {
    const { app, course, topics, prompts, tools } = setup(lessonSteps);
    const lesson = await startLesson(app, course.id, topics[0]!.id);
    const done = await ready(app, lesson.id);
    const section = done.lesson.sections[1]!;
    expect(section.artifact).toMatchObject({ kind: "project_milestone", spec: { title: "Count the tokens", cases: [{ name: "one number", expected: "tokens: 1" }, { name: "a sum", expected: "tokens: 3" }] } });
    expect(JSON.stringify(done)).not.toContain("referenceSolution");
    expect(JSON.stringify(done)).not.toContain("sys.stdin");
    expect(prompts.join("\n")).toContain("referenceSolution failed");
    expect(prompts[0]).toContain("This is a project course");
    expect(tools[0]).toContain("set_project_milestone");
    // Not checked yet, so the lesson can't be finished.
    expect(done.lesson.checks).toEqual({ total: 1, answered: 0 });
    expect(done.lesson.canFinish).toBe(false);
  });

  it("offers no milestone tool outside a project course's lessons", async () => {
    const { app, course, topics, tools } = setup(
      [
        outline([{ title: "Build it", kind: "project_milestone" }, { title: "Check", kind: "multiple_choice" }]),
        { text: "" },
      ],
      "lessons",
    );
    const lesson = await startLesson(app, course.id, topics[0]!.id);
    await vi.waitFor(async () => expect((await getLesson(app, lesson.id)).lesson.status).toBe("failed"), { timeout: 15_000 });
    expect(tools[0]).not.toContain("set_project_milestone");
  });

  it("serves the current milestone's cases as data, and grades each mivra check, replacing the last", async () => {
    const { app, store, course, topics } = setup(lessonSteps);
    expect((await milestoneOf(app, course.id)).status).toBe(409);
    const lesson = await startLesson(app, course.id, topics[0]!.id);
    const before = await ready(app, lesson.id);
    const res = await milestoneOf(app, course.id);
    expect(res.status).toBe(200);
    const cases = (await res.json()) as MilestoneCases;
    expect(cases).toEqual({
      courseId: course.id,
      lessonId: lesson.id,
      artifactId: expect.any(String),
      position: 1,
      title: "Count the tokens",
      checkType: "tests",
      cases: [
        { name: "one number", input: "42", compare: "stdout" },
        { name: "a sum", input: "1 + 2", compare: "stdout" },
      ],
    });
    // Data only: nothing in it names a command, and the expected outputs come with a check's result instead.
    expect(JSON.stringify(cases)).not.toMatch(/command|tokens:/);

    // A failing check: recorded as the milestone's attempt, which is enough to finish (scores never block).
    const first = await check(app, cases.artifactId, ["tokens: 1", "tokens: 2"]);
    expect(first.status).toBe(201);
    const graded = (await first.json()) as MilestoneCheckResult;
    expect(graded).toEqual({ grade: { correct: false, passed: 1, total: 2, cases: [{ passed: true }, { passed: false }] }, expected: ["tokens: 1", "tokens: 3"] });
    const afterFirst = await getLesson(app, lesson.id);
    expect(afterFirst.lesson.checks).toEqual({ total: 1, answered: 1 });
    expect(afterFirst.lesson.canFinish).toBe(true);
    expect(afterFirst.revision).not.toBe(before.revision);

    // Checking again replaces the attempt and changes the page's revision.
    const second = await check(app, cases.artifactId, ["tokens: 1\n", "tokens: 3  "]);
    expect(((await second.json()) as MilestoneCheckResult).grade.correct).toBe(true);
    const afterSecond = await getLesson(app, lesson.id);
    expect(afterSecond.revision).not.toBe(afterFirst.revision);
    expect(afterSecond.lesson.sections[1]!.artifact!.latestAttempt!.grade.passed).toBe(2);
    expect(store.listRecentEvidence(10).filter((e) => e.concept === "tokenizing")).toHaveLength(1);

    // Bad results, and the one-attempt route, are refused.
    expect((await check(app, cases.artifactId, ["only one"])).status).toBe(400);
    expect((await app.request(`/api/artifacts/${cases.artifactId}/checks`, { method: "POST", headers: json, body: JSON.stringify({ results: [{ stdout: "x" }] }) })).status).toBe(400);
    const once = await app.request(`/api/artifacts/${cases.artifactId}/attempts`, { method: "POST", headers: json, body: JSON.stringify({ answer: { results: [] } }) });
    expect(once.status).toBe(400);
    expect(((await once.json()) as { error: string }).error).toContain("mivra check");

    // Once the lesson is finished, the milestone is frozen and the next one hasn't started.
    expect((await app.request(`/api/lessons/${lesson.id}/finish`, { method: "POST", headers: auth })).status).toBe(200);
    expect((await check(app, cases.artifactId, ["tokens: 1", "tokens: 3"])).status).toBe(409);
    const next = await milestoneOf(app, course.id);
    expect(next.status).toBe(409);
    expect(((await next.json()) as { error: string }).error).toContain("hasn't started");
  });

  it("refuses milestone checks for courses of lessons and unknown ids", async () => {
    const { app, course } = setup([], "lessons");
    expect((await milestoneOf(app, course.id)).status).toBe(409);
    expect((await milestoneOf(app, "nope")).status).toBe(404);
    expect((await check(app, "nope", ["x"])).status).toBe(404);
  });

  it("refuses to remove a milestone from its lesson", async () => {
    const steps = [...lessonSteps];
    const { app, course, topics, prompts } = setup(steps);
    const lesson = await startLesson(app, course.id, topics[0]!.id);
    const done = await ready(app, lesson.id);
    const sectionId = (done.lesson.sections[1] as { id?: string }).id!;
    // The tutor in the drawer, asked to drop the milestone.
    steps.push({ toolCall: { name: "change_lesson", input: { reason: "Drop it", operations: [{ op: "remove", sectionId }] } } }, { text: "I can't." });
    const res = await app.request(`/api/sessions/${course.sessionId}/chat`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ message: { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "remove the milestone" }] }, lessonId: lesson.id }),
    });
    await res.text();
    expect(prompts.at(-1)).toContain("A milestone can't be removed from its lesson.");
    expect((await getLesson(app, lesson.id)).lesson.sections.map((s) => s.kind)).toEqual(["prose", "artifact"]);
  });
});

describe("checking a milestone's Python reference", () => {
  // Each check starts Pyodide in a fresh subprocess, which takes several seconds (much longer on a busy machine).
  vi.setConfig({ testTimeout: 180_000 });

  it("records what the reference prints as each case's expected output, and refuses one that fails", async () => {
    const prepared = await prepareProjectMilestone(milestone, runCasesInChild);
    expect(prepared.ok && prepared.spec.cases.map((c) => c.expected)).toEqual(["tokens: 1", "tokens: 3"]);
    const broken = await prepareProjectMilestone({ ...milestone, referenceSolution: "print(undefined_name)" }, runCasesInChild);
    expect(!broken.ok && broken.reason).toMatch(/case 0 \("one number"\).*NameError/);
    const silent = await prepareProjectMilestone({ ...milestone, referenceSolution: "pass" }, runCasesInChild);
    expect(!silent.ok && silent.reason).toContain("printed nothing");
  });
});
