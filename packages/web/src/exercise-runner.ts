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

/** How often an idle, loaded worker is asked whether it's stuck. */
export const HEARTBEAT_MS = 1_000;

const BUSY_WORKER = "The runner was still busy with code from an earlier run, so it was restarted. Run again.";

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
   * For a runtime that loads slowly (Python). The worker sends `started` when a case begins: the hard limit runs
   * from then, and loading has `startupLimitMs`. Once loaded, the worker is pinged while idle, and terminated if
   * it doesn't answer within the hard limit: code a case left to run later mustn't keep it busy. Without this,
   * the hard limit runs from when the case is sent.
   */
  startupLimitMs?: number;
}

/** One worker and what the page knows about it. */
interface Live {
  worker: WorkerLike;
  /** It has started a case, so its runtime is loaded. */
  loaded: boolean;
  /** When the unanswered ping was sent. */
  pinged?: number;
  heartbeat?: ReturnType<typeof setInterval>;
}

/** Runs cases in a Web Worker, one at a time, each with a hard time limit. */
export function createCaseRunner({ spawn = newWorker("javascript"), hardLimitMs = HARD_CASE_LIMIT_MS, startupLimitMs }: CaseRunnerOptions = {}): CaseRunner {
  let live: Live | undefined;
  let nextId = 0;
  let cancel: (() => void) | undefined;

  const kill = () => {
    if (!live) return;
    clearInterval(live.heartbeat);
    live.worker.terminate();
    live = undefined;
  };

  const current = (): Live => {
    if (live) return live;
    const fresh: Live = { worker: spawn(), loaded: false };
    fresh.worker.addEventListener("message", (({ data }: MessageEvent<ExerciseWorkerResponse>) => {
      if ("pong" in data) fresh.pinged = undefined;
    }) as EventListener);
    live = fresh;
    return fresh;
  };

  const watch = (target: Live) => {
    if (startupLimitMs === undefined || !target.loaded || target !== live) return;
    target.pinged = undefined;
    target.heartbeat = setInterval(() => {
      if (target.pinged !== undefined) {
        if (Date.now() - target.pinged >= hardLimitMs) kill();
        return;
      }
      target.pinged = Date.now();
      target.worker.postMessage({ id: ++nextId, kind: "ping" } satisfies ExerciseWorkerRequest);
    }, HEARTBEAT_MS);
  };

  return {
    run(code, functionName, testCase, { onStart } = {}) {
      const target = current();
      clearInterval(target.heartbeat);
      const { worker } = target;
      const id = ++nextId;
      return new Promise<ExerciseCaseRun>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          worker.removeEventListener("message", onMessage as EventListener);
          worker.removeEventListener("error", onError);
          cancel = undefined;
        };
        const finish = (run: ExerciseCaseRun) => {
          cleanup();
          watch(target);
          resolve(run);
        };
        const fail = (error: string) => {
          cleanup();
          kill();
          resolve({ stdout: "", error });
        };
        const timeLimit = () => fail(`Time limit exceeded (${EXERCISE_LIMITS.timeMs / 1000} s): the code ran too long, or never stopped.`);
        const onMessage = ({ data }: MessageEvent<ExerciseWorkerResponse>) => {
          if (data.id !== id || "pong" in data) return;
          if ("started" in data) {
            target.loaded = true;
            clearTimeout(timer);
            timer = setTimeout(timeLimit, hardLimitMs);
            onStart?.();
            return;
          }
          if (data.restart) {
            cleanup();
            kill();
            return resolve(data.ok ? data.run : { stdout: "", error: data.error });
          }
          if (data.ok) finish(data.run);
          else finish({ stdout: "", error: `The code couldn't run: ${data.error}` });
        };
        // The worker crashed (it may have run out of memory). A fresh one takes the next case.
        const onError = (event: Event) => {
          event.preventDefault();
          fail("The code stopped the runner, probably by using too much memory.");
        };
        if (startupLimitMs === undefined) {
          timer = setTimeout(timeLimit, hardLimitMs);
          onStart?.();
        } else if (target.loaded) {
          // Loaded already, so the case should start at once; if not, earlier code is keeping the worker busy.
          timer = setTimeout(() => fail(BUSY_WORKER), hardLimitMs);
        } else {
          timer = setTimeout(() => fail("Python took too long to start. Check your connection to Mivra and try again."), startupLimitMs);
        }
        cancel = () => {
          cleanup();
          kill();
          reject(new RunStopped());
        };
        worker.addEventListener("message", onMessage as EventListener);
        worker.addEventListener("error", onError);
        worker.postMessage({ id, kind: "case", code, functionName, testCase } satisfies ExerciseWorkerRequest);
      });
    },
    warm() {
      if (live) return;
      current().worker.postMessage({ id: ++nextId, kind: "warm" } satisfies ExerciseWorkerRequest);
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
