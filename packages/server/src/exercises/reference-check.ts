import { fork, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXERCISE_LIMITS,
  ExerciseCaseRun,
  expectedFrom,
  normaliseOutput,
  type CodeExerciseInput,
  type CodeExerciseSpec,
  type ExerciseLanguage,
  type ProjectMilestoneInput,
  type ProjectMilestoneSpec,
} from "@mivra/protocol";
import { z } from "zod";

/** The subprocess's heap. QuickJS's memory is capped per case inside it (EXERCISE_LIMITS.memoryBytes). */
const MAX_HEAP_MB = 256;
/** Starting the process and compiling QuickJS, beyond the cases' own time. */
const STARTUP_MS = 10_000;
/** Starting the process and Pyodide: it compiles about 10 MB of WebAssembly and starts Python, which is slow on a busy machine. */
const PYTHON_STARTUP_MS = 90_000;
/** Each case's own limit, plus room for a long native call to overrun it before the interrupt handler runs. */
const PER_CASE_MS = EXERCISE_LIMITS.timeMs + 3_000;
const KILL_GRACE_MS = 2_000;

export type RunCases = (
  job: { language: ExerciseLanguage; code: string; functionName?: string; cases: CodeExerciseInput["cases"] },
  signal?: AbortSignal,
) => Promise<ExerciseCaseRun[]>;

const Report = z.union([
  z.object({ ok: z.literal(true), results: z.array(ExerciseCaseRun) }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

const fromSource = import.meta.url.endsWith(".ts");

function childTarget(name: "exercise-child" | "python-child"): { path: string; execArgv: string[] } {
  if (!fromSource) return { path: fileURLToPath(new URL(`./${name}.js`, import.meta.url)), execArgv: [] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { path: fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), execArgv: ["--conditions=@mivra/source", "--import", tsx] };
}

/** The `node_modules` directory a path is in, if any. */
function modulesDir(path: string): string | undefined {
  const parts = path.split(sep);
  const at = parts.lastIndexOf("node_modules");
  return at === -1 ? undefined : parts.slice(0, at + 1).join(sep);
}

const swapCase = (text: string) => text.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

/**
 * Node's permission model for the Python child (ADR-016): it may read only code (its own package and the
 * `node_modules` directories it and its dependencies are installed in, which Node's resolver looks through),
 * and may not write files, start processes or load native addons. The data directory is never readable. From source, the child runs through
 * tsx, which needs the repository, a loader thread and no cache; tsx also tests whether the file system is
 * case-sensitive by looking for the working directory with its case swapped, so that (missing) path is allowed.
 */
function pythonPermissions(childPath: string): { execArgv: string[]; env: Record<string, string>; cwd?: string } {
  const require = createRequire(childPath);
  const pyodide = require.resolve("pyodide");
  const repo = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
  const packageRoot = dirname(dirname(childPath));
  const dependencies = [pyodide, createRequire(pyodide).resolve("ws"), require.resolve("zod")].map((file) => realpathSync(file));
  const readable = fromSource
    ? [repo]
    : [packageRoot, modulesDir(packageRoot), ...dependencies.flatMap((file) => [dirname(file), modulesDir(file)])].filter((path): path is string => path !== undefined);
  return {
    execArgv: [
      "--permission",
      ...[...new Set(readable.flatMap((path) => [path, realpathSync(path)]))].map((path) => `--allow-fs-read=${path}`),
      ...(fromSource ? ["--allow-worker", `--allow-fs-read=${swapCase(repo)}`] : []),
      "--disallow-code-generation-from-strings",
    ],
    env: fromSource ? { TSX_DISABLE_CACHE: "1" } : {},
    ...(fromSource ? { cwd: repo } : {}),
  };
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Runs code on an exercise's cases in a subprocess (ADR-016): QuickJS or Pyodide in a Node process with an
 * empty environment and its own heap limit, killed if it runs past the cases' time. Python's child also runs
 * under Node's permission model (see pythonPermissions). Rejects with a message the model can act on.
 */
export const runCasesInChild: RunCases = ({ language, ...job }, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The reply was stopped."));
    const python = language === "python";
    let child: ChildProcess;
    try {
      const { path, execArgv } = childTarget(python ? "python-child" : "exercise-child");
      const locked: { execArgv: string[]; env: Record<string, string>; cwd?: string } = python ? pythonPermissions(path) : { execArgv: [], env: {} };
      child = fork(path, [], {
        ...(locked.cwd ? { cwd: locked.cwd } : {}),
        execArgv: [...execArgv, ...locked.execArgv, `--max-old-space-size=${MAX_HEAP_MB}`],
        env: { ...locked.env, ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch {
      return reject(new Error("Mivra couldn't start the reference check."));
    }
    let settled = false;
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (alive(child)) {
        child.kill("SIGTERM");
        setTimeout(() => alive(child) && child.kill("SIGKILL"), KILL_GRACE_MS).unref();
      }
      act();
    };
    const onAbort = () => settle(() => reject(new Error("The reply was stopped.")));
    const timer = setTimeout(
      () => settle(() => reject(new Error("The reference solution took too long overall, so the check was stopped. Make the cases smaller or faster."))),
      (python ? PYTHON_STARTUP_MS : STARTUP_MS) + PER_CASE_MS * job.cases.length,
    );
    signal?.addEventListener("abort", onAbort);
    child.on("message", (message: unknown) => {
      const report = Report.safeParse(message);
      if (!report.success) return settle(() => reject(new Error("The reference check sent an unreadable result.")));
      if (!report.data.ok) return settle(() => reject(new Error(`The reference check failed: ${report.data.ok === false ? report.data.message : ""}`)));
      const { results } = report.data;
      if (results.length !== job.cases.length) return settle(() => reject(new Error("The reference check sent an unreadable result.")));
      settle(() => resolve(results));
    });
    child.on("error", () => settle(() => reject(new Error("Mivra couldn't run the reference check."))));
    child.once("exit", () => settle(() => reject(new Error("The reference check stopped before reporting, probably out of memory."))));
    child.send(job, (error) => {
      if (error) settle(() => reject(new Error("Mivra couldn't run the reference check.")));
    });
  });

/**
 * Checks a new exercise (ADR-016): runs the reference solution on every case and records what it produced as
 * the expected results. If the reference fails on any case, the exercise is refused with the reason, so the
 * model can fix it and call again. The starter code is never run.
 */
export async function prepareCodeExercise(
  input: CodeExerciseInput,
  runCases: RunCases,
  signal?: AbortSignal,
): Promise<{ ok: true; spec: CodeExerciseSpec } | { ok: false; reason: string }> {
  let results: ExerciseCaseRun[];
  try {
    results = await runCases({ language: input.language, code: input.referenceSolution, functionName: input.functionName, cases: input.cases }, signal);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The reference check failed." };
  }
  const failures = results.flatMap((run, i) => (run.error !== undefined ? [`case ${i} (${input.cases[i]!.kind}): ${run.error}`] : []));
  if (failures.length > 0) {
    return {
      ok: false,
      reason: `referenceSolution failed, so the exercise wasn't shown. Fix the reference or the cases and call ask_code_exercise again. ${failures.slice(0, 5).join("; ")}`,
    };
  }
  return {
    ok: true,
    spec: { ...input, cases: input.cases.map((testCase, i) => ({ ...testCase, expected: expectedFrom(testCase, results[i]!) })) },
  };
}

/**
 * Checks a new project milestone (ADR-016): runs the Python reference on every case's input in Pyodide, and what it
 * prints becomes that case's expected output. A reference that fails on any case, or prints nothing for every case,
 * refuses the milestone with the reason, so the model can fix it and call again.
 */
export async function prepareProjectMilestone(
  input: ProjectMilestoneInput,
  runCases: RunCases,
  signal?: AbortSignal,
): Promise<{ ok: true; spec: ProjectMilestoneSpec } | { ok: false; reason: string }> {
  const cases = input.cases ?? [];
  if (input.referenceSolution === undefined || cases.length === 0) return { ok: false, reason: "A tests milestone needs cases and a referenceSolution." };
  let results: ExerciseCaseRun[];
  try {
    results = await runCases({ language: "python", code: input.referenceSolution, cases: cases.map((c) => ({ kind: "stdio" as const, stdin: c.input })) }, signal);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The reference check failed." };
  }
  const failures = results.flatMap((run, i) => (run.error !== undefined ? [`case ${i} ("${cases[i]!.name}"): ${run.error}`] : []));
  if (failures.length === 0 && results.every((run) => normaliseOutput(run.stdout) === "")) {
    failures.push("the reference printed nothing for any case, so there is nothing to compare with");
  }
  if (failures.length > 0) {
    return {
      ok: false,
      reason: `referenceSolution failed, so the milestone wasn't set. Fix the reference or the cases and call set_project_milestone again. ${failures.slice(0, 5).join("; ")}`,
    };
  }
  return { ok: true, spec: { ...input, cases: cases.map((testCase, i) => ({ ...testCase, expected: normaliseOutput(results[i]!.stdout) })) } };
}
