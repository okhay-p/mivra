import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CourseView,
  MAX_CASE_OUTPUT_CHARS,
  MAX_MILESTONE_STDERR_CHARS,
  MilestoneCases,
  MilestoneCheckResult,
  normaliseOutput,
  type MilestoneCaseResult,
} from "@mivra/protocol";
import { z } from "zod";
import { CREDENTIALS_FILE, ServerToken, readRemoteServer, removeRemoteServer, saveRemoteServer } from "../../server/src/credentials.js";
import { TOKEN_FILE } from "../../server/src/security.js";
import { changesToSend, collectChanges, type Changes } from "./repo-files.js";
import { CommandError, fillPlaceholders, runProgram, splitCommand, stopCurrent, type ProgramRun, type RunLimits } from "./run-command.js";
import { running } from "./state.js";

/**
 * Project courses in the learner's own repository (ADR-016): `mivra link` records which course the repository builds
 * and the command that runs the learner's program, and `mivra check` runs that command on the current milestone's
 * cases and sends what it printed to the running Mivra, which grades it. The server only ever sends data: the
 * commands that run are the ones in `.mivra.json`, which the learner wrote.
 */

export const LINK_FILE = ".mivra.json";

/** `.mivra.json`: safe to commit. It holds no secrets: the server address and token stay in the data dir. */
const LinkFile = z.object({
  course: z.string().min(1),
  /** The learner's command, e.g. `./build/mycc {input}`. */
  run: z.string().min(1),
  /** For cases that run the program's output (e.g. generated assembly): a command with `{output}`. */
  runOutput: z.string().min(1).optional(),
});
type LinkFile = z.infer<typeof LinkFile>;

/** Output kept from one run; well over a case's expected output, to leave room for generated code to run. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type Io = { out: (message: string) => void; err: (message: string) => void };

class ProjectError extends Error {}

/**
 * How to reach Mivra: the remote one saved with `mivra link --server` (ADR-016), else the one running from this data
 * dir, with its token, as `mivra import` finds it.
 */
async function server(dataDir: string): Promise<{ url: string; token: string; remote: boolean }> {
  const remote = readRemoteServer(dataDir);
  if (remote) return { ...remote, remote: true };
  const local = await running(dataDir);
  if (!local) throw new ProjectError("Mivra isn't running. Start it with `mivra start --detach`, then try again.");
  try {
    return { url: local.url, token: readFileSync(join(dataDir, TOKEN_FILE), "utf8").trim(), remote: false };
  } catch {
    throw new ProjectError(`Couldn't read Mivra's API token from ${join(dataDir, TOKEN_FILE)}.`);
  }
}

/** Calls Mivra's API. Errors name what to fix and never include the token. */
function client({ url, token, remote }: { url: string; token: string; remote: boolean }) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const relink = `Get its token from Settings → Connect a CLI, or \`mivra token\` where it runs, and run \`mivra link --server ${url}\` again.`;
  return async (path: string, init: RequestInit = {}, timeoutMs = 30_000) => {
    let res: Response;
    try {
      // A redirect isn't followed: the token goes only to the address the learner gave.
      res = await fetch(`${url}/api${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ProjectError(remote ? `Couldn't reach Mivra at ${url}. Check it's running and that this computer can reach it.` : `Couldn't reach Mivra at ${url}.`);
    }
    if (res.ok) return res.json() as Promise<unknown>;
    if (res.status >= 300 && res.status < 400) throw redirected(url, res);
    const message = ((await res.json().catch(() => ({}))) as { error?: unknown }).error;
    if (remote && res.status === 401) throw new ProjectError(`Mivra at ${url} didn't accept the token. ${relink}`);
    if (remote && res.status === 403 && message === "Host not allowed") throw hostRefused(url);
    throw new ProjectError(typeof message === "string" ? message : `Mivra answered ${res.status}.`);
  };
}

async function connect(dataDir: string) {
  const found = await server(dataDir);
  return { url: found.url, remote: found.remote, call: client(found) };
}

/** Mivra's Host guard refused the name in the address (ADR-013), which is fixed where Mivra runs. */
const hostRefused = (url: string) =>
  new ProjectError(`Mivra at ${url} doesn't accept requests for ${new URL(url).hostname}. Add it to MIVRA_ALLOWED_HOSTS where Mivra runs, and restart it.`);

/** A redirect isn't followed with the token, so name where it goes instead. */
const redirected = (url: string, res: Response) => {
  const location = res.headers.get("location");
  return new ProjectError(`${url} redirects${location ? ` to ${location}` : ""}, which Mivra doesn't follow. Use Mivra's own address: \`mivra link --server <url>\`.`);
};

/** Says whether there's a Mivra at the address, without the token, so a wrong address isn't mistaken for a wrong token. */
async function isMivra(url: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    return false;
  }
  if (res.status >= 300 && res.status < 400) throw redirected(url, res);
  const body = (await res.json().catch(() => ({}))) as { ok?: unknown; error?: unknown };
  // The Host guard answers before every route, health included, so a missing MIVRA_ALLOWED_HOSTS shows up here first.
  if (res.status === 403 && body.error === "Host not allowed") throw hostRefused(url);
  return res.ok && body.ok === true;
}

/**
 * `mivra link --server <url>`: checks the token works there, then saves both in the data dir's credentials file
 * (ADR-013's store), never in `.mivra.json`.
 */
async function connectRemote(url: string, dataDir: string, readToken: () => Promise<string>, io: Io) {
  if (!(await isMivra(url))) throw new ProjectError(`There's no Mivra answering at ${url}. Check the address, and that Mivra is running there.`);
  let input: string;
  try {
    input = await readToken();
  } catch (error) {
    throw new ProjectError((error as Error).message);
  }
  const token = ServerToken.safeParse(input);
  if (!token.success) throw new ProjectError(input ? token.error.issues[0]!.message : "No token given.");
  // Any authenticated read proves the token; this one is small and calls no model.
  await client({ url, token: token.data, remote: true })("/settings/tasks");
  saveRemoteServer(dataDir, { url, token: token.data });
  io.out(`Connected to Mivra at ${url}. Its address and token are saved in ${join(dataDir, CREDENTIALS_FILE)}, not in .mivra.json.`);
  const { hostname, protocol } = new URL(url);
  if (protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    io.err("The token goes over plain HTTP to that address. That's only safe on a network that encrypts traffic itself, such as a tailnet.");
  }
}

/** Checks a command can be run as Mivra will run it, and says why not. */
function checkCommand(command: string, where: string) {
  try {
    splitCommand(command);
  } catch (error) {
    if (error instanceof CommandError) throw new ProjectError(`${where}: ${error.message}`);
    throw error;
  }
}

/** Reports what went wrong, if it's something the learner can act on. */
function failed(error: unknown, io: Io): number {
  if (error instanceof ProjectError) io.err(error.message);
  else if (error instanceof z.ZodError) io.err("Mivra answered with something this `mivra` doesn't understand. Update it to the same version as the running Mivra.");
  else throw error;
  return 1;
}

/**
 * `mivra link <course> --run <command>`: writes `.mivra.json` in the current directory. `--server <url>` first
 * connects this computer to a Mivra on another one; `--local` goes back to the one running here.
 */
export async function link(
  { course, run, runOutput, server: url, local }: { course?: string; run?: string; runOutput?: string; server?: string; local?: boolean },
  { dataDir, cwd, readToken }: { dataDir: string; cwd: string; readToken: () => Promise<string> },
  io: Io,
): Promise<number> {
  try {
    if (run !== undefined) checkCommand(run, "--run");
    if (runOutput !== undefined) {
      checkCommand(runOutput, "--run-output");
      if (!runOutput.includes("{output}")) throw new ProjectError('--run-output needs {output} where the path to your program\'s output goes, e.g. "./run-asm.sh {output}".');
    }
    if (local) io.out(removeRemoteServer(dataDir) ? "Forgot the remote Mivra: link and check use the one running on this computer again." : "Link and check already use the Mivra running on this computer.");
    if (url) await connectRemote(url, dataDir, readToken, io);
    if (course === undefined || run === undefined) return 0;
    const { call, url: at, remote } = await connect(dataDir);
    const found = CourseView.parse(await call(`/courses/${encodeURIComponent(course)}`));
    if (found.kind !== "project") throw new ProjectError(`"${found.goal}" isn't a project course, so there's nothing to check from a repository.`);
    const path = join(cwd, LINK_FILE);
    const file: LinkFile = { course: found.id, run, ...(runOutput ? { runOutput } : {}) };
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    io.out(`Linked this folder to "${found.goal}"${remote ? ` on Mivra at ${at}` : ""} in ${path}. It holds no secrets, so you can commit it.`);
    io.out(`Mivra will run: ${run}${run.includes("{input}") ? "" : "  (each case's input comes on stdin; add {input} to get it as a file path too)"}`);
    io.out("Run `mivra check` here to check the current milestone.");
    return 0;
  } catch (error) {
    return failed(error, io);
  }
}

/** The nearest `.mivra.json`, from `cwd` up. */
function findLink(cwd: string): { path: string; file: LinkFile } {
  let dir = resolve(cwd);
  for (;;) {
    const path = join(dir, LINK_FILE);
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // Not here; look further up.
    }
    if (text !== undefined) {
      let parsed;
      try {
        parsed = LinkFile.safeParse(JSON.parse(text));
      } catch {
        throw new ProjectError(`${path} isn't valid JSON. Run \`mivra link\` again to rewrite it.`);
      }
      if (!parsed.success) throw new ProjectError(`${path} needs "course" and "run". Run \`mivra link\` again to rewrite it.`);
      return { path, file: parsed.data };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new ProjectError(`No ${LINK_FILE} here or above. Link this folder to a project course first: \`mivra link <course> --run "<command>"\`.`);
    dir = parent;
  }
}

/** One case's result as it's sent: normalised, cut to what can be compared, with only the end of stderr. */
function caseResult(run: ProgramRun): MilestoneCaseResult {
  const stdout = normaliseOutput(run.stdout);
  const stderr = run.stderr.slice(-MAX_MILESTONE_STDERR_CHARS);
  return {
    stdout: stdout.slice(0, MAX_CASE_OUTPUT_CHARS),
    ...(stdout.length > MAX_CASE_OUTPUT_CHARS ? { truncated: true } : {}),
    ...(stderr ? { stderr } : {}),
    exitCode: run.exitCode,
    ...(run.error ? { error: run.error } : {}),
  };
}

/**
 * Runs one case in a fresh temporary folder: the input goes to the program on stdin and in a file whose path replaces
 * `{input}`. For a run_output case, what the program printed goes in a file whose path replaces `{output}` in the
 * learner's run-output command, and that command's output is what's compared.
 */
async function runCase(
  link: LinkFile,
  testCase: MilestoneCases["cases"][number],
  { cwd, limits }: { cwd: string; limits: RunLimits },
): Promise<{ result: MilestoneCaseResult; startError?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mivra-check-"));
  try {
    const input = join(dir, "input");
    writeFileSync(input, testCase.input);
    const first = await runProgram(fillPlaceholders(splitCommand(link.run), { input }), { cwd, stdin: testCase.input, limits });
    if (testCase.compare !== "run_output" || first.error || first.exitCode !== 0) return { result: caseResult(first), startError: first.startError };
    if (!link.runOutput) return { result: { stdout: "", exitCode: null, error: "no_run_output_command" } };
    const output = join(dir, "output");
    writeFileSync(output, first.stdout);
    const second = await runProgram(fillPlaceholders(splitCommand(link.runOutput), { input, output }), { cwd, stdin: "", limits });
    return { result: caseResult(second), startError: second.startError };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ERROR_TEXT: Record<NonNullable<MilestoneCaseResult["error"]>, string> = {
  timeout: "stopped: it took longer than the time limit",
  output_limit: "stopped: it printed more than the output limit",
  start_failed: "couldn't start",
  no_run_output_command: 'this case runs your program\'s output: set a command for that with `mivra link <course> --run "…" --run-output "… {output}"`',
};

/** The first few lines of a text, indented, for showing beside another. */
const excerpt = (text: string, lines = 8) => {
  const all = text.split("\n");
  const shown = all.slice(0, lines).map((line) => `        ${line}`);
  return [...shown, ...(all.length > lines ? [`        … (${all.length - lines} more lines)`] : [])].join("\n");
};

/** How long a check's POST may take: the server answers once the model has reviewed the code. */
const CHECK_TIMEOUT_MS = 5 * 60_000;

const kb = (chars: number) => `${(chars / 1024).toFixed(1)} KB`;

const SKIP_TEXT: Record<Changes["skipped"][number]["reason"], string> = {
  secret: "looks like it holds a secret: never sent, not even its name",
  not_a_file: "a link or folder: never followed",
  binary: "binary",
  too_large: "too large to review",
  size_cap: "over the size Mivra sends for one check",
  lockfile: "a lockfile",
};

/** Lists what a check sends for review, as `--dry-run` shows it and a check sums it up. */
function describeChanges(changes: Changes, io: Io, { full }: { full: boolean }) {
  if (changes.source === "none") {
    io.out(changes.note ?? "No files to send.");
    return;
  }
  const total = changes.files.reduce((sum, f) => sum + f.content.length, 0);
  const what = changes.sinceUsed ? "changed since the last passed milestone" : "in the repository (no earlier passed milestone to compare with)";
  if (!full) {
    io.out(`Sending ${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} (${kb(total)}) ${what} for review${changes.skipped.length ? `, leaving out ${changes.skipped.length}` : ""}. See them with \`mivra check --dry-run\`.`);
    return;
  }
  io.out(changes.files.length === 0 ? `No files ${what} to send.` : `Files ${what} that would be sent for review (${changes.files.length}, ${kb(total)}):`);
  for (const file of changes.files) io.out(`  ${file.path}  (${kb(file.content.length)})`);
  if (changes.skipped.length > 0) {
    io.out("Not sent:");
    for (const skip of changes.skipped) io.out(`  ${skip.path}  (${SKIP_TEXT[skip.reason]})`);
  }
  if (changes.deleted.length > 0) io.out(`Named as deleted: ${changes.deleted.join(", ")}`);
  if (changes.commit) io.out(`Commit: ${changes.commit}`);
}

const CRITERIA = [
  ["noHardCodedOutputs", "Computes its output"],
  ["concept", "Shows the milestone's concept"],
  ["quality", "Code quality"],
] as const;

/** Prints what the review found. */
function showReview(review: MilestoneCheckResult["review"], io: Io) {
  if (review.status === "skipped") {
    io.out(review.reason === "tests_failed" ? "Review: not yet, since the tests must pass first." : "Review: nothing was sent to review, so the milestone can't pass yet.");
    return;
  }
  if (review.status === "failed") {
    io.out(`Review: it didn't finish (${review.error}). Run mivra check again.`);
    return;
  }
  const { review: verdict } = review;
  io.out(`Review (judged by a model, ${verdict.model}): ${verdict.approved ? "approved" : "changes requested"}`);
  for (const [key, label] of CRITERIA) io.out(`  ${verdict[key].passed ? "pass" : "FAIL"}  ${label}: ${verdict[key].note}`);
  io.out(`  ${verdict.summary}`);
  for (const suggestion of verdict.suggestions) io.out(`  - ${suggestion}`);
  if (!verdict.approved) io.out("  You can dispute the verdict from the milestone in Mivra.");
}

/** `mivra check`: runs the learner's command on the current milestone's cases and records the result in Mivra. */
export async function check({ timeoutS, dryRun = false }: { timeoutS: number; dryRun?: boolean }, { dataDir, cwd }: { dataDir: string; cwd: string }, io: Io): Promise<number> {
  // The program runs in its own process group, so Ctrl+C reaches only Mivra: stop the program with it.
  const onInterrupt = () => {
    stopCurrent();
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  try {
    const found = findLink(cwd);
    const root = dirname(found.path);
    checkCommand(found.file.run, `"run" in ${found.path}`);
    if (found.file.runOutput) checkCommand(found.file.runOutput, `"runOutput" in ${found.path}`);
    const { call, url, remote } = await connect(dataDir);
    if (remote) io.out(`Checking against Mivra at ${url}; your program runs here.`);
    const milestone = MilestoneCases.parse(await call(`/courses/${encodeURIComponent(found.file.course)}/milestone`));
    const count = milestone.checkType === "review" ? "checked by review" : `${milestone.cases.length} ${milestone.cases.length === 1 ? "case" : "cases"}`;
    io.out(`Milestone ${milestone.position}: ${milestone.title} (${count})`);
    const changes = await collectChanges(root, milestone.since);
    if (dryRun) {
      if (milestone.cases.length > 0) io.out(`A check would run your command on ${milestone.cases.length} ${milestone.cases.length === 1 ? "case" : "cases"} and send what it printed.`);
      describeChanges(changes, io, { full: true });
      io.out("Nothing was run or sent.");
      return 0;
    }
    const limits = { timeoutMs: timeoutS * 1000, maxOutputBytes: MAX_OUTPUT_BYTES };
    const results: MilestoneCaseResult[] = [];
    for (const testCase of milestone.cases) {
      const { result, startError } = await runCase(found.file, testCase, { cwd: root, limits });
      results.push(result);
      if (startError) {
        io.err(`Couldn't run your command (${startError}). Check the commands in ${found.path}; they run from ${root}.`);
        return 1;
      }
    }
    describeChanges(changes, io, { full: false });
    const body = { results, revision: milestone.revision, ...changesToSend(changes) };
    const graded = MilestoneCheckResult.parse(
      await call(`/artifacts/${encodeURIComponent(milestone.artifactId)}/checks`, { method: "POST", body: JSON.stringify(body) }, CHECK_TIMEOUT_MS),
    );
    milestone.cases.forEach((testCase, i) => {
      const passed = graded.grade.cases[i]?.passed ?? false;
      io.out(`  ${passed ? "pass" : "FAIL"}  ${testCase.name}`);
      if (passed) return;
      const result = results[i]!;
      if (result.error) io.out(`        ${ERROR_TEXT[result.error]}`);
      else {
        if (result.exitCode !== 0) io.out(`        exited with code ${result.exitCode}`);
        io.out(`      expected:\n${excerpt(graded.expected[i] ?? "")}`);
        io.out(`      got:${result.stdout ? `\n${excerpt(result.stdout)}` : " (nothing)"}${result.truncated ? "\n        … (cut short)" : ""}`);
      }
      if (result.stderr) io.out(`      stderr:\n${excerpt(result.stderr, 4)}`);
    });
    const { passed, total } = graded.grade;
    if (total > 0) io.out(passed === total ? `All ${total} cases passed.` : `${passed} of ${total} cases passed.`);
    showReview(graded.review, io);
    io.out(graded.passed ? "Milestone passed. Recorded in Mivra." : "Not passed yet. Recorded in Mivra.");
    return graded.passed ? 0 : 1;
  } catch (error) {
    return failed(error, io);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}
