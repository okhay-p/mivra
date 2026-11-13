import { EXERCISE_LIMITS, type ExerciseCaseInput, type ExerciseCaseRun, type ExerciseLanguage, type ExercisePublicCase } from "@mivra/protocol";
import type { ExerciseWorkerRequest, ExerciseWorkerResponse } from "./exercise.worker.js";

/**
 * How long one case may take before the page terminates the worker. QuickJS stops a case at its own time limit,
 * but only between bytecode instructions, and Python's interrupt check doesn't run during a long call into C, so a
 * case can overrun; this is the hard stop.
 */
export const HARD_CASE_LIMIT_MS = EXERCISE_LIMITS.timeMs + 3_000;

/** How long Python may take to load (about 12 MB of files, then starting the interpreter) before a run gives up. */
export const PYTHON_STARTUP_LIMIT_MS = 120_000;

/** Just what running a case needs: its input. Expected results and whether it's hidden stay on the page. */
export const caseInput = (testCase: ExercisePublicCase): ExerciseCaseInput =>
  testCase.kind === "stdio" ? { kind: "stdio", stdin: testCase.stdin } : { kind: "call", args: testCase.args };

export class RunStopped extends Error {
  constructor() {
    super("Stopped");
  }
}

export interface CaseRunner {
  /**
   * Runs one case. Rejects with RunStopped if `stop()` is called meanwhile. `onStart` is called when the case
   * itself starts, after the runtime has loaded.
   */
  run(code: string, functionName: string | undefined, testCase: ExerciseCaseInput, options?: { onStart?: () => void }): Promise<ExerciseCaseRun>;
  /** Starts loading the runtime, so the first run doesn't wait for it. */
  warm(): void;
  /** Terminates the worker and rejects the case in progress. The next run starts a new worker. */
  stop(): void;
  dispose(): void;
}

type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;

const newWorker = (language: ExerciseLanguage) => (): WorkerLike =>
  language === "python"
    ? new Worker(new URL("./python-exercise.worker.ts", import.meta.url), { type: "module", name: "mivra-python-exercise" })
    : new Worker(new URL("./exercise.worker.ts", import.meta.url), { type: "module", name: "mivra-exercise" });

export interface CaseRunnerOptions {
  spawn?: () => WorkerLike;
  hardLimitMs?: number;
  /**
   * The worker sends `started` when a case begins, after loading its runtime: the hard limit runs from then,
   * and loading has `startupLimitMs`. Otherwise the hard limit runs from when the case is sent.
   */
  startupLimitMs?: number;
}

/** Runs cases in a Web Worker, one at a time, each with a hard time limit. */
export function createCaseRunner({ spawn = newWorker("javascript"), hardLimitMs = HARD_CASE_LIMIT_MS, startupLimitMs }: CaseRunnerOptions = {}): CaseRunner {
  let worker: WorkerLike | undefined;
  let nextId = 0;
  let cancel: (() => void) | undefined;

  const kill = () => {
    worker?.terminate();
    worker = undefined;
  };

  return {
    run(code, functionName, testCase, { onStart } = {}) {
      worker ??= spawn();
      const current = worker;
      const id = ++nextId;
      return new Promise<ExerciseCaseRun>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          current.removeEventListener("message", onMessage as EventListener);
          current.removeEventListener("error", onError);
          cancel = undefined;
        };
        const timeLimit = () => {
          cleanup();
          kill();
          resolve({ stdout: "", error: `Time limit exceeded (${EXERCISE_LIMITS.timeMs / 1000} s): the code ran too long, or never stopped.` });
        };
        const onMessage = ({ data }: MessageEvent<ExerciseWorkerResponse>) => {
          if (data.id !== id) return;
          if ("started" in data) {
            clearTimeout(timer);
            timer = setTimeout(timeLimit, hardLimitMs);
            onStart?.();
            return;
          }
          cleanup();
          if (data.restart) kill();
          if (data.ok) resolve(data.run);
          else resolve({ stdout: "", error: data.error.startsWith("Python couldn't start") ? data.error : `The code couldn't run: ${data.error}` });
        };
        // The worker crashed (it may have run out of memory). A fresh one takes the next case.
        const onError = (event: Event) => {
          event.preventDefault();
          cleanup();
          kill();
          resolve({ stdout: "", error: "The code stopped the runner, probably by using too much memory." });
        };
        if (startupLimitMs === undefined) {
          timer = setTimeout(timeLimit, hardLimitMs);
          onStart?.();
        } else {
          timer = setTimeout(() => {
            cleanup();
            kill();
            resolve({ stdout: "", error: "Python took too long to start. Check your connection to Mivra and try again." });
          }, startupLimitMs);
        }
        cancel = () => {
          cleanup();
          kill();
          reject(new RunStopped());
        };
        current.addEventListener("message", onMessage as EventListener);
        current.addEventListener("error", onError);
        current.postMessage({ id, code, functionName, testCase } satisfies ExerciseWorkerRequest);
      });
    },
    warm() {
      if (worker) return;
      worker = spawn();
      worker.postMessage({ id: ++nextId, warm: true } satisfies ExerciseWorkerRequest);
    },
    stop() {
      if (cancel) cancel();
      else kill();
    },
    dispose() {
      cancel?.();
      kill();
    },
  };
}

/** The runner for an exercise's language. */
export const createRunnerFor = (language: ExerciseLanguage): CaseRunner =>
  language === "python" ? createCaseRunner({ spawn: newWorker("python"), startupLimitMs: PYTHON_STARTUP_LIMIT_MS }) : createCaseRunner({ spawn: newWorker("javascript") });
