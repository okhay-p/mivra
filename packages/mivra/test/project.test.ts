import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Whether a process still runs. A killed process its new parent hasn't reaped yet (a zombie) doesn't. */
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Runs the built `mivra`; `input` is piped to it, as when a token is pasted into it. */
const run = (dataDir: string, cwd: string, args: string[], input?: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(node, [bin, ...args], { cwd, env: { PATH: process.env.PATH, HOME: dataDir, MIVRA_DATA_DIR: dataDir }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 90_000 });
    child.stdin?.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
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
    if (process.platform !== "win32") await expect.poll(() => running(grandchild), { timeout: 5_000 }).toBe(false);
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

describe("a project course on another computer's Mivra", () => {
  // A second address on loopback stands in for the home server: it isn't a loopback name, so the Mivra there only
  // answers because it's in MIVRA_ALLOWED_HOSTS, and treats requests as remote, as behind `tailscale serve`.
  it.skipIf(process.platform !== "linux")("links and checks with the address and token in the client's data dir, never in .mivra.json", async ({ expect, onTestFinished }) => {
    const serverData = tempDir("mivra-home-");
    const { courseId, lessonId } = seedProjectCourse(serverData);
    const port = await freePort();
    const host = "127.0.0.2";
    const url = `http://${host}:${port}`;
    const server = spawn(node, [bin, "start", "--no-open", "--port", String(port)], {
      cwd: serverData,
      env: { PATH: process.env.PATH, HOME: serverData, MIVRA_DATA_DIR: serverData, MIVRA_HOST: host, MIVRA_ALLOWED_HOSTS: host },
      stdio: "ignore",
    });
    onTestFinished(() => {
      server.kill("SIGKILL");
    });
    const up = Date.now() + 60_000;
    for (;;) {
      const ok = await fetch(`${url}/api/health`).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() > up || server.exitCode !== null) throw new Error("The home Mivra didn't start");
      await new Promise((r) => setTimeout(r, 200));
    }

    // On the server: `mivra token` prints only the token on stdout.
    const printed = await run(serverData, serverData, ["token"]);
    expect(printed.code, printed.stderr).toBe(0);
    const token = printed.stdout.trim();
    expect(token).toBe(readFileSync(join(serverData, "auth-token"), "utf8").trim());
    expect(printed.stderr).toContain("mivra link --server");
    // Without the token, the remote address answers nothing but health.
    expect((await fetch(`${url}/api/courses/${courseId}`)).status).toBe(401);

    // The laptop: its own data dir, with no Mivra running in it.
    const clientData = tempDir("mivra-laptop-");
    const repo = tempDir("mivra-repo-");
    writeFileSync(join(repo, "calc.mjs"), `import { readFileSync } from "node:fs";
      const nums = readFileSync(process.argv[2], "utf8").split(/\\s+/).filter(Boolean).map(Number);
      console.log(String(nums.reduce((a, b) => a + b, 0)));`);
    writeFileSync(join(repo, "run-output.mjs"), `import { readFileSync } from "node:fs"; console.log("ran: " + readFileSync(process.argv[2], "utf8").trim());`);

    const wrong = await run(clientData, repo, ["link", "--server", url], "not-the-right-token-at-all");
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("didn't accept the token");
    expect(wrong.stderr).not.toContain("not-the-right-token");
    expect(existsSync(join(clientData, "credentials.json"))).toBe(false);
    expect((await run(clientData, repo, ["link", "--server", `http://${host}:${await freePort()}`], token)).stderr).toContain("no Mivra answering");

    const connected = await run(clientData, repo, ["link", "--server", `${url}/`], `${token}\n`);
    expect(connected.code, connected.stderr).toBe(0);
    expect(connected.stdout).toContain(`Connected to Mivra at ${url}`);
    expect(connected.stdout + connected.stderr).not.toContain(token);
    const credentials = join(clientData, "credentials.json");
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(credentials, "utf8"))).toEqual({ keys: {}, server: { url, token } });

    const linked = await run(clientData, repo, ["link", courseId, "--run", `"${node}" calc.mjs {input}`, "--run-output", `"${node}" run-output.mjs {output}`]);
    expect(linked.code, linked.stderr).toBe(0);
    expect(linked.stdout).toContain(`on Mivra at ${url}`);
    const linkText = readFileSync(join(repo, ".mivra.json"), "utf8");
    expect(JSON.parse(linkText)).toEqual({ course: courseId, run: `"${node}" calc.mjs {input}`, runOutput: `"${node}" run-output.mjs {output}` });
    expect(linkText).not.toContain(token);
    expect(linkText).not.toContain(host);
    expect(linkText).not.toContain(String(port));

    const checked = await run(clientData, repo, ["check"]);
    expect(checked.stdout).toContain(`Checking against Mivra at ${url}`);
    expect(checked.stdout).toContain("All 3 cases passed. Recorded in Mivra.");
    expect(checked.code, checked.stderr).toBe(0);
    expect(existsSync(join(clientData, "mivra.pid"))).toBe(false);
    const lesson = (await (await fetch(`${url}/api/lessons/${lessonId}`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      lesson: { sections: { artifact?: { latestAttempt?: { grade: { passed: number; correct: boolean } } } }[] };
    };
    expect(lesson.lesson.sections[1]!.artifact!.latestAttempt!.grade).toMatchObject({ passed: 3, correct: true });

    // Back to the local Mivra, which isn't running here.
    const local = await run(clientData, repo, ["link", "--local"]);
    expect(local.stdout).toContain("Forgot the remote Mivra");
    expect(JSON.parse(readFileSync(credentials, "utf8"))).toEqual({ keys: {} });
    expect((await run(clientData, repo, ["check"])).stderr).toContain("Mivra isn't running");
  }, 180_000);

  it("doesn't follow a redirect with the token, and says what to fix", async ({ expect, onTestFinished }) => {
    const elsewhere: (string | undefined)[] = [];
    const target = createServer((req, res) => {
      elsewhere.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const targetPort = await freePort();
    await new Promise<void>((resolve) => target.listen(targetPort, "127.0.0.1", resolve));
    const redirecting = createServer((req, res) => {
      if (req.url === "/api/health") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      if (req.url?.startsWith("/api/courses/")) return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Host not allowed" }));
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}${req.url}` }).end();
    });
    const port = await freePort();
    await new Promise<void>((resolve) => redirecting.listen(port, "127.0.0.1", resolve));
    onTestFinished(() => {
      target.close();
      redirecting.close();
    });
    const clientData = tempDir("mivra-laptop-");
    const repo = tempDir("mivra-repo-");
    const token = "a-token-that-must-stay-home-0123456789";
    const linked = await run(clientData, repo, ["link", "--server", `http://127.0.0.1:${port}`], token);
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain("redirects to");
    expect(elsewhere).toEqual([]);
    expect(existsSync(join(clientData, "credentials.json"))).toBe(false);
    // An address that redirects everything, as plain HTTP to HTTPS would.
    const everything = createServer((req, res) => res.writeHead(301, { location: `https://127.0.0.1:${targetPort}${req.url}` }).end());
    const everythingPort = await freePort();
    await new Promise<void>((resolve) => everything.listen(everythingPort, "127.0.0.1", resolve));
    onTestFinished(() => {
      everything.close();
    });
    expect((await run(clientData, repo, ["link", "--server", `http://127.0.0.1:${everythingPort}`], token)).stderr).toContain(`redirects to https://127.0.0.1:${targetPort}/api/health`);

    // A saved server whose Host check refuses this name.
    writeFileSync(join(clientData, "credentials.json"), JSON.stringify({ keys: {}, server: { url: `http://127.0.0.1:${port}`, token } }));
    const refused = await run(clientData, repo, ["link", "c1", "--run", `"${node}" -e 1`]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("MIVRA_ALLOWED_HOSTS");
    expect(existsSync(join(repo, ".mivra.json"))).toBe(false);

    // The first `link --server` against a Mivra that doesn't list this name names the fix too.
    const guarded = createServer((_req, res) => res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Host not allowed" })));
    const guardedPort = await freePort();
    await new Promise<void>((resolve) => guarded.listen(guardedPort, "127.0.0.1", resolve));
    onTestFinished(() => {
      guarded.close();
    });
    const fresh = tempDir("mivra-laptop-");
    const first = await run(fresh, repo, ["link", "--server", `http://127.0.0.1:${guardedPort}`], token);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("MIVRA_ALLOWED_HOSTS");
    expect(existsSync(join(fresh, "credentials.json"))).toBe(false);
  });
});
