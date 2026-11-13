import { CodeExerciseSpec } from "@mivra/protocol";
import { addLinesExercise, brokenReferenceExercise, loopingReferenceExercise, sumExercise, sumSolution } from "@mivra/protocol/test/code-exercise-fixtures";
import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { artifacts, attempts, runs } from "../src/db/schema.js";
import { prepareCodeExercise, runCasesInChild } from "../src/exercises/reference-check.js";

// The reference runs in a real subprocess, which is slow when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Step = { toolCall: { name: string; input: unknown } } | { text: string };

function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++] ?? { text: "ok" };
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
}

function setup(steps: Step[]) {
  const db = openDb(":memory:");
  const model = scriptedModel(steps);
  const app = createApp({ db, model: () => model, security: { token: TOKEN, allowedHosts: [] } });
  return { app, db, model };
}
type App = ReturnType<typeof setup>["app"];

async function newSession(app: App) {
  return ((await (await app.request("/api/sessions", { method: "POST", headers: auth })).json()) as { id: string }).id;
}

async function turn(app: App, db: Db, sessionId: string, text: string) {
  const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
  const res = await app.request(`/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  expect(res.status).toBe(200);
  const sse = await res.text();
  await vi.waitFor(() => expect(db.select().from(runs).where(eq(runs.sessionId, sessionId)).all().every((r) => r.status !== "running")).toBe(true));
  return sse;
}

const submit = (app: App, artifactId: string, answer: unknown) =>
  app.request(`/api/artifacts/${artifactId}/attempts`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  });

describe("checking an exercise's reference at creation", () => {
  it("records the expected results from running the reference", async () => {
    const prepared = await prepareCodeExercise(sumExercise, runCasesInChild);
    expect(prepared.ok).toBe(true);
    const spec = CodeExerciseSpec.parse(prepared.ok && prepared.spec);
    expect(spec.cases.map((c) => c.expected)).toEqual([{ returned: "6" }, { returned: "0" }, { returned: "10" }]);

    const stdio = await prepareCodeExercise(addLinesExercise, runCasesInChild);
    expect(stdio.ok && stdio.spec.cases.map((c) => c.expected)).toEqual([{ stdout: "5" }, { stdout: "0" }]);
  });

  it("refuses an exercise whose reference throws, naming the case", async () => {
    const prepared = await prepareCodeExercise(brokenReferenceExercise, runCasesInChild);
    expect(prepared.ok).toBe(false);
    expect(!prepared.ok && prepared.reason).toMatch(/^referenceSolution failed.*case 1 \(call\): TypeError/);
  });

  it("refuses an exercise whose reference never stops", async () => {
    const prepared = await prepareCodeExercise(loopingReferenceExercise, runCasesInChild);
    expect(!prepared.ok && prepared.reason).toMatch(/case 0 \(call\): Time limit exceeded/);
  });

  it("kills the subprocess when the reply is stopped", async () => {
    const controller = new AbortController();
    const pending = runCasesInChild({ code: "while (true) {}", cases: [{ kind: "stdio", stdin: "" }] }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("The reply was stopped.");
  });

  it("gives the subprocess none of the server's environment", async () => {
    process.env.MIVRA_TEST_SECRET = "leak";
    try {
      // The code itself can't reach `process`; this checks the process QuickJS runs in.
      const [result] = await runCasesInChild({ code: "console.log(typeof process)", cases: [{ kind: "stdio", stdin: "" }] });
      expect(result).toEqual({ stdout: "undefined\n" });
    } finally {
      delete process.env.MIVRA_TEST_SECRET;
    }
  });
});

describe("code_exercise through the agent", () => {
  it("shows a checked exercise without the reference or hidden expected results, live and on reload", async () => {
    const { app, db, model } = setup([{ toolCall: { name: "ask_code_exercise", input: sumExercise } }, { text: "Have a go." }]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "give me an exercise");
    expect(sse).toContain('"kind":"code_exercise"');
    const reloaded = await (await app.request(`/api/sessions/${sessionId}/messages`, { headers: auth })).text();
    for (const body of [sse, reloaded]) {
      expect(body).not.toContain("referenceSolution");
      expect(body).not.toContain("total + x");
      expect(body).not.toContain('\\"10\\"');
      expect(body).toContain(sumExercise.title);
    }
    expect(model.doStreamCalls).toHaveLength(2);
    const stored = db.select().from(artifacts).get()!;
    expect(CodeExerciseSpec.parse(stored.spec).cases[2]!.expected).toEqual({ returned: "10" });
  });

  it("returns a failing reference to the model and stores nothing", async () => {
    const { app, db, model } = setup([
      { toolCall: { name: "ask_code_exercise", input: brokenReferenceExercise } },
      { toolCall: { name: "ask_code_exercise", input: sumExercise } },
      { text: "Try this." },
    ]);
    const sessionId = await newSession(app);
    const sse = await turn(app, db, sessionId, "exercise please");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("referenceSolution failed");
    expect(sse).not.toContain("referenceSolution failed");
    expect(db.select().from(artifacts).all().map((a) => (a.spec as { title: string }).title)).toEqual([sumExercise.title]);
  });

  it("grades a submission once, records evidence, and restores it on reload", async () => {
    const { app, db } = setup([{ toolCall: { name: "ask_code_exercise", input: sumExercise } }, { text: "Go." }]);
    const sessionId = await newSession(app);
    await turn(app, db, sessionId, "exercise");
    const artifactId = db.select().from(artifacts).get()!.id;

    expect((await submit(app, artifactId, {})).status).toBe(400);
    expect((await submit(app, artifactId, { code: sumSolution, results: [{ stdout: "", returned: "6" }] })).status).toBe(400);

    const results = [{ stdout: "", returned: "6" }, { stdout: "", returned: "0" }, { stdout: "", returned: "10" }];
    const res = await submit(app, artifactId, { code: sumSolution, results });
    expect(res.status).toBe(201);
    const view = (await res.json()) as { latestAttempt: { grade: unknown; answer: { code: string } }; spec: unknown };
    expect(view.latestAttempt.grade).toEqual({ correct: true, passed: 3, total: 3, cases: [{ passed: true }, { passed: true }, { passed: true }] });
    expect(JSON.stringify(view)).not.toContain("referenceSolution");

    expect((await submit(app, artifactId, { code: sumSolution, results })).status).toBe(409);
    expect(db.select().from(attempts).all()).toMatchObject([{ correct: true, concept: sumExercise.concept }]);

    const reloaded = await (await app.request(`/api/sessions/${sessionId}/messages`, { headers: auth })).text();
    expect(reloaded).toContain('"latestAttempt"');
    expect(reloaded).toContain("let total = 0");
  });

  it("fails a submission that got a hidden case wrong, and tells the model which", async () => {
    const { app, db, model } = setup([{ toolCall: { name: "ask_code_exercise", input: sumExercise } }, { text: "Go." }, { text: "Let's look at it." }]);
    const sessionId = await newSession(app);
    await turn(app, db, sessionId, "exercise");
    const artifactId = db.select().from(artifacts).get()!.id;
    const results = [{ stdout: "", returned: "6" }, { stdout: "", returned: "0" }, { stdout: "", returned: "20" }];
    const res = await submit(app, artifactId, { code: "function sum(xs) { return Math.abs(xs.reduce((a, b) => a + b, 0)) * 2 }", results });
    expect(((await res.json()) as { latestAttempt: { grade: unknown } }).latestAttempt.grade).toMatchObject({ correct: false, passed: 2, total: 3 });

    // Every check in the reply is answered, so the tutor continues on its own with the graded result.
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(3));
    await vi.waitFor(() => expect(db.select().from(runs).all().every((r) => r.status !== "running")).toBe(true));
    const prompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(prompt).toContain("passed 2 of 3 cases");
    expect(prompt).toContain("Math.abs");
    expect(prompt).toMatch(/failedCases.*case.*2.*hidden.*true/);
  });
});
