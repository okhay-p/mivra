import { EXERCISE_LIMITS, type ExerciseCaseInput, type ExerciseCaseRun, type ExercisePublicCase } from "@mivra/protocol";
import type { ExerciseWorkerRequest, ExerciseWorkerResponse } from "./exercise.worker.js";

/**
 * How long one case may take before the page terminates the worker. QuickJS stops a case at its own time limit,
 * but only between bytecode instructions, so a long native call can overrun it; this is the hard stop.
 */
export const HARD_CASE_LIMIT_MS = EXERCISE_LIMITS.timeMs + 3_000;

/** Just what running a case needs: its input. Expected results and whether it's hidden stay on the page. */
export const caseInput = (testCase: ExercisePublicCase): ExerciseCaseInput =>
  testCase.kind === "stdio" ? { kind: "stdio", stdin: testCase.stdin } : { kind: "call", args: testCase.args };

export class RunStopped extends Error {
  constructor() {
    super("Stopped");
  }
}

export interface CaseRunner {
  /** Runs one case. Rejects with RunStopped if `stop()` is called meanwhile. */
  run(code: string, functionName: string | undefined, testCase: ExerciseCaseInput): Promise<ExerciseCaseRun>;
  /** Terminates the worker and rejects the case in progress. The next run starts a new worker. */
  stop(): void;
  dispose(): void;
}

type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;

const newWorker = (): WorkerLike => new Worker(new URL("./exercise.worker.ts", import.meta.url), { type: "module", name: "mivra-exercise" });

/** Runs cases in a Web Worker, one at a time, each with a hard time limit. */
export function createCaseRunner(spawn: () => WorkerLike = newWorker, hardLimitMs = HARD_CASE_LIMIT_MS): CaseRunner {
  let worker: WorkerLike | undefined;
  let nextId = 0;
  let cancel: (() => void) | undefined;

  const kill = () => {
    worker?.terminate();
    worker = undefined;
  };

  return {
    run(code, functionName, testCase) {
      worker ??= spawn();
      const current = worker;
      const id = ++nextId;
      return new Promise<ExerciseCaseRun>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          current.removeEventListener("message", onMessage as EventListener);
          current.removeEventListener("error", onError);
          cancel = undefined;
        };
        const onMessage = ({ data }: MessageEvent<ExerciseWorkerResponse>) => {
          if (data.id !== id) return;
          cleanup();
          if (data.ok) resolve(data.run);
          else resolve({ stdout: "", error: `The code couldn't run: ${data.error}` });
        };
        // The worker crashed (it may have run out of memory). A fresh one takes the next case.
        const onError = (event: Event) => {
          event.preventDefault();
          cleanup();
          kill();
          resolve({ stdout: "", error: "The code stopped the runner, probably by using too much memory." });
        };
        const timer = setTimeout(() => {
          cleanup();
          kill();
          resolve({ stdout: "", error: `Time limit exceeded (${EXERCISE_LIMITS.timeMs / 1000} s): the code ran too long, or never stopped.` });
        }, hardLimitMs);
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
