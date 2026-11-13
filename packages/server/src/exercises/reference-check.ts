import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXERCISE_LIMITS, ExerciseCaseRun, expectedFrom, type CodeExerciseInput, type CodeExerciseSpec } from "@mivra/protocol";
import { z } from "zod";

/** The subprocess's heap. QuickJS's memory is capped per case inside it (EXERCISE_LIMITS.memoryBytes). */
const MAX_HEAP_MB = 256;
/** Starting the process and compiling QuickJS, beyond the cases' own time. */
const STARTUP_MS = 10_000;
/** Each case's own limit, plus room for a long native call to overrun it before the interrupt handler runs. */
const PER_CASE_MS = EXERCISE_LIMITS.timeMs + 3_000;
const KILL_GRACE_MS = 2_000;

export type RunCases = (job: { code: string; functionName?: string; cases: CodeExerciseInput["cases"] }, signal?: AbortSignal) => Promise<ExerciseCaseRun[]>;

const Report = z.union([
  z.object({ ok: z.literal(true), results: z.array(ExerciseCaseRun) }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

function childTarget(): { path: string; execArgv: string[] } {
  if (!import.meta.url.endsWith(".ts")) return { path: fileURLToPath(new URL("./exercise-child.js", import.meta.url)), execArgv: [] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { path: fileURLToPath(new URL("./exercise-child.ts", import.meta.url)), execArgv: ["--conditions=@mivra/source", "--import", tsx] };
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Runs code on an exercise's cases in a subprocess (ADR-016): QuickJS in a Node process with an empty
 * environment and its own heap limit, killed if it runs past the cases' time. Rejects with a message the
 * model can act on.
 */
export const runCasesInChild: RunCases = (job, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The reply was stopped."));
    const { path, execArgv } = childTarget();
    let child: ChildProcess;
    try {
      child = fork(path, [], {
        execArgv: [...execArgv, `--max-old-space-size=${MAX_HEAP_MB}`],
        env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
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
      STARTUP_MS + PER_CASE_MS * job.cases.length,
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
    results = await runCases({ code: input.referenceSolution, functionName: input.functionName, cases: input.cases }, signal);
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
