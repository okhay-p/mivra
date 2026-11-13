import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";
import { openDb } from "../../server/src/db/client.js";
import { createLessonStore } from "../../server/src/store/lesson-store.js";
import { createSessionStore } from "../../server/src/store/session-store.js";

/**
 * `mivra link` and `mivra check` (ADR-016), run as the learner would: the built `mivra` in a repository folder, against
 * a fake Mivra (to control exactly what the server sends) or a real one started with `mivra start --detach`.
 */

const bin = fileURLToPath(new URL("../bin/mivra.js", import.meta.url));
const node = process.execPath;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const run = (dataDir: string, cwd: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(node, [bin, ...args], { cwd, env: { PATH: process.env.PATH, HOME: dataDir, MIVRA_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/** A stand-in Mivra that answers as the real one does, with whatever milestone a test gives it, and records each check. */
async function fakeMivra(milestone: unknown) {
  const dataDir = tempDir("mivra-fake-");
  const checks: { results: { stdout: string; exitCode: number | null; error?: string }[] }[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let body = "";
    req.setEncoding("utf8").on("data", (c: string) => (body += c)).on("end", () => resolve(body));
  });
  const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    if (req.url === "/api/health") return send(res, 200, { ok: true });
    if (req.headers.authorization !== "Bearer fake-token") return send(res, 401, { error: "Unauthorized" });
    if (req.method === "GET" && req.url === "/api/courses/course-1/milestone") return send(res, 200, milestone);
    if (req.method === "POST" && req.url === "/api/artifacts/artifact-1/checks") {
      const body = JSON.parse(await read(req)) as (typeof checks)[number];
      checks.push(body);
      const cases = body.results.map((r) => ({ passed: r.exitCode === 0 && !r.error }));
      const passed = cases.filter((c) => c.passed).length;
      return send(res, 201, { grade: { correct: passed === cases.length, passed, total: cases.length, cases }, expected: body.results.map(() => "") });
    }
    send(res, 404, { error: "Not found" });
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  // The record a running Mivra keeps: this test process stands in for its pid.
  writeFileSync(join(dataDir, "mivra.pid"), JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }));
  writeFileSync(join(dataDir, "auth-token"), "fake-token\n");
  return { dataDir, checks, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const linkFile = (repo: string, file: object) => writeFileSync(join(repo, ".mivra.json"), JSON.stringify(file));

describe.concurrent("mivra check", () => {
  it("runs only the learner's command: nothing the server sends can change it", async ({ expect, onTestFinished }) => {
    const hostile = ["; touch PWNED", "$(touch PWNED) `touch PWNED` {input} {output} | touch PWNED", "' \" \\ && touch PWNED"];
    const fake = await fakeMivra({
      courseId: "course-1",
      lessonId: "lesson-1",
      artifactId: "artifact-1",
      position: 1,
      title: "$(touch PWNED)",
      checkType: "tests",
      cases: hostile.map((input, i) => ({ name: `{input} ; touch PWNED ${i}`, input, compare: "stdout" })),
    });
    onTestFinished(fake.close);
    const repo = tempDir("mivra-repo-");
    // Records exactly what it was started with, and what came on stdin and in the {input} file.
    writeFileSync(
      join(repo, "record.mjs"),
      `import { appendFileSync, readFileSync } from "node:fs";
       let stdin = ""; process.stdin.on("data", (d) => (stdin += d)).on("end", () => {
         appendFileSync("calls.jsonl", JSON.stringify({ argv: process.argv.slice(2), stdin, file: readFileSync(process.argv[2], "utf8") }) + "\\n");
         console.log("ok");
       });`,
    );
    linkFile(repo, { course: "course-1", run: `"${node}" record.mjs {input} "literal {not a placeholder}"` });
    const checked = await run(fake.dataDir, repo, ["check"]);
    expect(checked.code, checked.stderr).toBe(0);
    const calls = readFileSync(join(repo, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; stdin: string; file: string });
    expect(calls).toHaveLength(hostile.length);
    calls.forEach((call, i) => {
      // The learner's two arguments, with {input} as a path Mivra made; the case's text arrives only as data.
      expect(call.argv).toHaveLength(2);
      expect(call.argv[0]).toMatch(/mivra-check-[^/\\]+[/\\]input$/);
      expect(call.argv[1]).toBe("literal {not a placeholder}");
      expect(call.stdin).toBe(hostile[i]);
      expect(call.file).toBe(hostile[i]);
    });
    expect(readdirSync(repo).sort()).toEqual([".mivra.json", "calls.jsonl", "record.mjs"]);
    expect(existsSync(join(process.cwd(), "PWNED"))).toBe(false);
    expect(fake.checks).toHaveLength(1);
    expect(fake.checks[0]!.results.map((r) => r.stdout)).toEqual(["ok", "ok", "ok"]);
  });

  it("refuses a milestone that carries anything but data, and runs nothing", async ({ expect, onTestFinished }) => {
    const fake = await fakeMivra({
      courseId: "course-1",
      lessonId: "lesson-1",
      artifactId: "artifact-1",
      position: 1,
      title: "t",
      checkType: "tests",
      run: "touch PWNED",
      cases: [{ name: "n", input: "", compare: "stdout", command: "touch PWNED" }],
    });
    onTestFinished(fake.close);
    const repo = tempDir("mivra-repo-");
    writeFileSync(join(repo, "record.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("ran", "");`);
    linkFile(repo, { course: "course-1", run: `"${node}" record.mjs` });
    const checked = await run(fake.dataDir, repo, ["check"]);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain("doesn't understand");
    expect(readdirSync(repo).sort()).toEqual([".mivra.json", "record.mjs"]);
    expect(fake.checks).toHaveLength(0);
  });

  it("stops a program that hangs or prints without end, and the rest still run", async ({ expect, onTestFinished }) => {
    const fake = await fakeMivra({
      courseId: "course-1",
      lessonId: "lesson-1",
      artifactId: "artifact-1",
      position: 2,
      title: "Limits",
      checkType: "tests",
      cases: ["hang", "flood", "fine"].map((input) => ({ name: input, input, compare: "stdout" })),
    });
    onTestFinished(fake.close);
    const repo = tempDir("mivra-repo-");
    writeFileSync(
      join(repo, "prog.mjs"),
      `import { spawn } from "node:child_process"; import { readFileSync, writeFileSync } from "node:fs";
       const input = readFileSync(process.argv[2], "utf8");
       if (input === "hang") {
         const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
         writeFileSync("grandchild.pid", String(child.pid));
         setInterval(() => {}, 1000);
       } else if (input === "flood") {
         const line = "y".repeat(1000) + "\\n"; const go = () => { while (process.stdout.write(line)); process.stdout.once("drain", go); }; go();
       } else console.log("fine");`,
    );
    linkFile(repo, { course: "course-1", run: `"${node}" prog.mjs {input}` });
    const started = Date.now();
    const checked = await run(fake.dataDir, repo, ["check", "--timeout", "2"]);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain("took longer than the time limit");
    expect(checked.stdout).toContain("printed more than the output limit");
    expect(checked.stdout).toMatch(/pass {2}fine/);
    expect(fake.checks[0]!.results.map((r) => r.error ?? r.stdout)).toEqual(["timeout", "output_limit", "fine"]);
    const grandchild = Number(readFileSync(join(repo, "grandchild.pid"), "utf8"));
    if (process.platform !== "win32") expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("explains what's missing before it runs anything", async ({ expect }) => {
    const repo = tempDir("mivra-repo-");
    const dataDir = tempDir("mivra-data-");
    expect((await run(dataDir, repo, ["check"])).stderr).toContain("No .mivra.json here or above");
    linkFile(repo, { course: "c", run: "make && ./mycc {input}" });
    expect((await run(dataDir, repo, ["check"])).stderr).toContain("without a shell");
    linkFile(repo, { course: "c", run: `"${node}" -e 1` });
    expect((await run(dataDir, repo, ["check"])).stderr).toContain("Mivra isn't running");
    const link = await run(dataDir, repo, ["link", "c"]);
    expect(link.code).toBe(2);
    expect(link.stderr).toContain("--run");
  });
});

/** A project course with its first milestone written, as the tutor would leave it, straight into a new data dir. */
function seedProjectCourse(dataDir: string) {
  const db = openDb(join(dataDir, "mivra.db"), { migrationsFolder: fileURLToPath(new URL("../../server/drizzle", import.meta.url)) });
  const store = createSessionStore(db);
  const lessons = createLessonStore(db);
  const { course } = store.createCourse("A tiny calculator", "project");
  store.writeFirstSyllabus(course.id, null, {
    topics: [
      { title: "Add numbers", summary: "s", reason: "r", requestedByLearner: false, concepts: ["parsing"] },
      { title: "Compile it", summary: "s", reason: "r", requestedByLearner: false, concepts: ["code generation"] },
    ],
    known: [],
  });
  const topic = store.latestSyllabus(course.id)!.topics[0]!;
  const { lesson } = lessons.createLesson({ courseId: course.id, topicId: topic.id, topicTitle: topic.title, position: 0 });
  const session = store.findSession(lesson.sessionId)!;
  const runId = store.startRun(session, { id: "m", role: "user", parts: [{ type: "text", text: "lesson" }] });
  lessons.writeOutline(lesson.id, { title: "Add numbers", sections: [{ title: "The idea", kind: "prose", purpose: "p" }, { title: "Build it", kind: "project_milestone", purpose: "p" }] });
  lessons.appendSection(lesson.id, { kind: "prose", title: "The idea", markdown: "Add the numbers on each line.", artifactId: null }, 0);
  const artifact = store.createArtifact({
    sessionId: lesson.sessionId,
    runId,
    toolCallId: "call-1",
    kind: "project_milestone",
    version: 1,
    spec: {
      concept: "parsing",
      title: "Add the numbers",
      spec: "Print the sum of the numbers in the input.",
      outputFormat: "One line: the sum.",
      checkType: "tests",
      cases: [
        { name: "two numbers", input: "1 2", expected: "3" },
        { name: "none", input: "", expected: "0" },
        // The learner's program prints a program; Mivra runs that with their run-output command.
        { name: "compiled", input: "4 5", compare: "run_output", expected: "ran: 9" },
      ],
      referenceSolution: "import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))\n",
    },
  });
  lessons.appendSection(lesson.id, { kind: "artifact", title: "Build it", markdown: null, artifactId: artifact.id }, 1);
  store.finishRun(runId, session.id, "completed");
  lessons.setStatus(lesson.id, "ready");
  const other = store.createCourse("Calculus").course;
  return { courseId: course.id, otherCourseId: other.id, lessonId: lesson.id };
}

describe("a project course end to end", () => {
  it("links a repository, checks a milestone against a running Mivra, and records each check", async ({ expect, onTestFinished }) => {
    const dataDir = tempDir("mivra-project-");
    const { courseId, otherCourseId, lessonId } = seedProjectCourse(dataDir);
    const port = await freePort();
    const start = await run(dataDir, dataDir, ["start", "--detach", "--no-open", "--port", String(port)]);
    expect(start.code, start.stderr).toBe(0);
    const { pid, url } = JSON.parse(readFileSync(join(dataDir, "mivra.pid"), "utf8")) as { pid: number; url: string };
    onTestFinished(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    });

    // The learner's repository: a program that adds wrongly (it forgets the last number), and a script that "runs" its
    // output, as an assembler and a linker would run generated code.
    const repo = tempDir("mivra-repo-");
    mkdirSync(join(repo, "src"));
    const program = (bug: boolean) =>
      `import { readFileSync } from "node:fs";
       const nums = readFileSync(process.argv[2], "utf8").split(/\\s+/).filter(Boolean).map(Number);
       console.log(String(nums.slice(0, ${bug ? "-1" : "undefined"}).reduce((a, b) => a + b, 0)));`;
    writeFileSync(join(repo, "calc.mjs"), program(true));
    writeFileSync(join(repo, "run-output.mjs"), `import { readFileSync } from "node:fs"; console.log("ran: " + readFileSync(process.argv[2], "utf8").trim());`);

    const wrongKind = await run(dataDir, repo, ["link", otherCourseId, "--run", "node calc.mjs {input}"]);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.stderr).toContain("isn't a project course");
    expect((await run(dataDir, repo, ["link", "no-such-course", "--run", "node calc.mjs {input}"])).stderr).toContain("Course not found");

    const linked = await run(dataDir, repo, ["link", courseId, "--run", `"${node}" calc.mjs {input}`]);
    expect(linked.code, linked.stderr).toBe(0);
    const file = JSON.parse(readFileSync(join(repo, ".mivra.json"), "utf8")) as Record<string, string>;
    expect(file).toEqual({ course: courseId, run: `"${node}" calc.mjs {input}` });
    // No secrets: neither the token nor the server's address.
    const token = readFileSync(join(dataDir, "auth-token"), "utf8").trim();
    expect(readFileSync(join(repo, ".mivra.json"), "utf8")).not.toContain(token);
    expect(readFileSync(join(repo, ".mivra.json"), "utf8")).not.toContain(String(port));

    // The run_output case needs a run-output command, which isn't set yet. From a subfolder, it finds .mivra.json above.
    const first = await run(dataDir, join(repo, "src"), ["check"]);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("Milestone 1: Add the numbers (3 cases)");
    expect(first.stdout).toMatch(/FAIL {2}two numbers\n\s+expected:\n\s+3\n\s+got:\n\s+1/);
    expect(first.stdout).toMatch(/pass {2}none/);
    expect(first.stdout).toContain("--run-output");
    expect(first.stdout).toContain("1 of 3 cases passed. Recorded in Mivra.");

    const headers = { authorization: `Bearer ${token}` };
    const lesson = async () =>
      ((await (await fetch(`${url}/api/lessons/${lessonId}`, { headers })).json()) as {
        lesson: { canFinish: boolean; sections: { artifact?: { latestAttempt?: { grade: { passed: number; correct: boolean } } } }[] };
      }).lesson;
    expect((await lesson()).sections[1]!.artifact!.latestAttempt!.grade).toMatchObject({ passed: 1, correct: false });
    // Checked once, so the lesson can be finished: scores never block (ADR-011).
    expect((await lesson()).canFinish).toBe(true);

    // Fixed, with a command that runs the "compiled" output.
    writeFileSync(join(repo, "calc.mjs"), program(false));
    const relinked = await run(dataDir, repo, ["link", courseId, "--run", `"${node}" calc.mjs {input}`, "--run-output", `"${node}" run-output.mjs {output}`]);
    expect(relinked.code, relinked.stderr).toBe(0);
    const fixed = await run(dataDir, repo, ["check"]);
    expect(fixed.stdout).toContain("All 3 cases passed. Recorded in Mivra.");
    expect(fixed.code, fixed.stderr).toBe(0);
    expect((await lesson()).sections[1]!.artifact!.latestAttempt!.grade).toMatchObject({ passed: 3, correct: true });

    // Finished, the milestone is frozen, and the next one hasn't started.
    expect((await fetch(`${url}/api/lessons/${lessonId}/finish`, { method: "POST", headers })).status).toBe(200);
    const after = await run(dataDir, repo, ["check"]);
    expect(after.code).toBe(1);
    expect(after.stderr).toContain("hasn't started");
    expect((await run(dataDir, dataDir, ["stop"])).stdout).toContain("Mivra stopped.");
  }, 180_000);
});
