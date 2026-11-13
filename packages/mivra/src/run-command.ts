import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";

/**
 * Running the learner's own command for `mivra check` (ADR-016). The command is the text the learner gave
 * `mivra link`; it is split into arguments here and started directly, never through a shell, so nothing in a case's
 * input or anything the server sends can become part of it. Only `{input}` and `{output}` are replaced, each with a
 * path Mivra chose, as a whole argument or part of one.
 */

export class CommandError extends Error {}

/** Characters a shell would treat as operators or expansions. Unquoted, they'd mean something they don't here. */
const SHELL_OPERATORS = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`"]);

/**
 * Splits a command into arguments, the way a shell would without running anything: spaces separate arguments,
 * single or double quotes keep one together, and on macOS and Linux a backslash escapes the next character. On Windows
 * a backslash is an ordinary character, so paths like `.\build\mycc.exe` work as typed. Pipes, redirects, `&&` and
 * variables aren't supported, so they are refused rather than passed on as text.
 */
export function splitCommand(command: string, platform: NodeJS.Platform = process.platform): string[] {
  const windows = platform === "win32";
  const args: string[] = [];
  let current: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else current = (current ?? "") + c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (!windows && c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) current = (current ?? "") + command[++i];
      else current = (current ?? "") + c;
    } else if (/\s/.test(c)) {
      if (current !== undefined) args.push(current);
      current = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
      current ??= "";
    } else if (!windows && c === "\\") {
      if (i + 1 >= command.length) throw new CommandError("The command ends with a backslash.");
      current = (current ?? "") + command[++i];
    } else if (SHELL_OPERATORS.has(c)) {
      throw new CommandError(
        `Mivra runs the command directly, without a shell, so "${c}" can't be used unquoted. Put pipes, redirects or several steps in a script and run that, e.g. ./check.sh {input}.`,
      );
    } else current = (current ?? "") + c;
  }
  if (quote) throw new CommandError(`The command has an unclosed ${quote === '"' ? "double" : "single"} quote.`);
  if (current !== undefined) args.push(current);
  if (args.length === 0) throw new CommandError("The command is empty.");
  return args;
}

/** The arguments to run: the learner's, with each placeholder replaced by its path. Nothing else changes. */
export function fillPlaceholders(args: readonly string[], paths: { input?: string; output?: string }): string[] {
  return args.map((arg) => arg.replaceAll("{input}", paths.input ?? "{input}").replaceAll("{output}", paths.output ?? "{output}"));
}

export interface RunLimits {
  /** Wall-clock time before the program (and anything it started) is killed. */
  timeoutMs: number;
  /** Bytes of stdout and stderr together before it is killed. */
  maxOutputBytes: number;
}

export interface ProgramRun {
  stdout: string;
  /** The end of what it wrote to stderr. */
  stderr: string;
  /** Null when it was killed or never started. */
  exitCode: number | null;
  error?: "timeout" | "output_limit" | "start_failed";
  /** Why it couldn't start, e.g. the program wasn't found. */
  startError?: string;
}

const STDERR_KEEP_CHARS = 2_000;
/** How long to wait for output to drain once the program exits, before stopping whatever it left running. */
const DRAIN_MS = 500;
/** How long to wait for a killed program's pipes to close. */
const KILL_WAIT_MS = 2_000;

/** Stops the program and everything it started: its process group on macOS and Linux, its process tree on Windows. */
function killTree(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** The running program, so Ctrl+C can stop it too. */
let active: ChildProcess | undefined;
export const stopCurrent = () => active && killTree(active);

/**
 * Runs one program with the given arguments, in `cwd`, writing `stdin` to it. Starts it without a shell (cross-spawn
 * quotes arguments correctly for Windows' `.cmd` and `.bat` files, such as npm's). On macOS and Linux it gets its own
 * process group, so a time limit or output limit stops anything it started too.
 */
export function runProgram(args: readonly string[], { cwd, stdin, limits, env = process.env }: { cwd: string; stdin: string; limits: RunLimits; env?: NodeJS.ProcessEnv }): Promise<ProgramRun> {
  return new Promise((resolve) => {
    const [file, ...rest] = args;
    let child: ChildProcess;
    try {
      const spawn = process.platform === "win32" ? crossSpawn : nodeSpawn;
      child = spawn(file!, rest, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      return resolve({ stdout: "", stderr: "", exitCode: null, error: "start_failed", startError: (error as Error).message });
    }
    active = child;
    const stdout: Buffer[] = [];
    let stderr = "";
    let bytes = 0;
    let error: ProgramRun["error"];
    let startError: string | undefined;
    let exitCode: number | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (active === child) active = undefined;
      // Anything it left running, or still holding its pipes, goes too. Windows finds a tree by its live parent only.
      if (process.platform !== "win32" || (child.exitCode === null && child.signalCode === null)) killTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: stderr.slice(-STDERR_KEEP_CHARS), exitCode: error ? null : exitCode, ...(error ? { error } : {}), ...(startError ? { startError } : {}) });
    };
    const stop = (reason: NonNullable<ProgramRun["error"]>) => {
      if (error || settled) return;
      error = reason;
      killTree(child);
      timers.push(setTimeout(finish, KILL_WAIT_MS));
    };
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxOutputBytes) stop("output_limit");
      return bytes <= limits.maxOutputBytes;
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (count(chunk)) stdout.push(chunk);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (count(Buffer.from(chunk))) stderr = (stderr + chunk).slice(-STDERR_KEEP_CHARS * 2);
    });
    child.once("error", (e) => {
      startError = e.message;
      error ??= "start_failed";
      finish();
    });
    child.once("exit", (code) => {
      exitCode = code;
      timers.push(setTimeout(finish, DRAIN_MS));
    });
    child.once("close", finish);
    timers.push(setTimeout(() => stop("timeout"), limits.timeoutMs));
    // A program that doesn't read its input closes stdin early; that isn't an error.
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
  });
}
