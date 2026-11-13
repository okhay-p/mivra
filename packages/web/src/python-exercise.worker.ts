/// <reference lib="webworker" />
import { ExerciseCaseInput, createPythonCaseRunner, type PythonCaseRunner } from "@mivra/protocol";
import type { loadPyodide as LoadPyodide } from "pyodide";
import { version } from "pyodide/package.json";
import type { ExerciseWorkerRequest, ExerciseWorkerResponse } from "./exercise.worker.js";

/**
 * Runs Python exercise cases in Pyodide (ADR-016), one case per message. Pyodide's files are Mivra's own assets
 * (see pyodideAssets in vite.config.ts), so this works offline. The worker gets only the exercise's code and
 * one case: never the API token or anything else from the page.
 *
 * Learner code mustn't reach the network. Three things stop it. Python gets no `js` module (see
 * createPythonCaseRunner). Once Pyodide has loaded, every network API is deleted from this worker's global
 * scope, and checked gone, before any code runs. And the server sends this script with a Content-Security-Policy
 * that forbids running strings as JavaScript (so no `import()` of another site) and connecting anywhere but
 * Mivra itself (`EXERCISE_WORKER_CSP` in packages/server/src/serve-web.ts).
 *
 * Python can't be interrupted from outside, so the page times each case from the `started` message and
 * terminates this worker if one overruns.
 */

const base = new URL(`/assets/pyodide-${version}/`, self.location.origin).href;

/** Every way a worker can reach the network or another context; none is needed once Pyodide has loaded. */
const NETWORK = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "importScripts",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "caches",
  "indexedDB",
] as const;

/** Deletes the network APIs from the global object and everything it inherits from. */
export function removeNetwork(scope: object = self) {
  for (let target: object | null = scope; target; target = Object.getPrototypeOf(target)) {
    for (const name of NETWORK) Reflect.deleteProperty(target, name);
  }
  const left = NETWORK.filter((name) => name in scope);
  if (left.length > 0) throw new Error(`Couldn't remove network access (${left.join(", ")}), so Python won't run.`);
}

let ready: Promise<PythonCaseRunner> | undefined;
const prepare = () =>
  (ready ??= (async () => {
    const { loadPyodide } = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as { loadPyodide: typeof LoadPyodide };
    const pyodide = await loadPyodide({ indexURL: base, jsglobals: {}, env: {}, stdout: () => {}, stderr: () => {} });
    removeNetwork();
    return createPythonCaseRunner(pyodide);
  })());

// Python a case left to run later (a callback scheduled through `pyodide.webloop`) is interrupted at once
// (createPythonCaseRunner), and its error surfaces here, between cases. It isn't the runner failing, so it stays here.
self.addEventListener("error", (event) => event.preventDefault());
self.addEventListener("unhandledrejection", (event) => event.preventDefault());

self.onmessage = async ({ data }: MessageEvent<ExerciseWorkerRequest>) => {
  const reply = (message: ExerciseWorkerResponse) => self.postMessage(message);
  // Answered before anything else, so the page can tell this worker isn't stuck.
  if (data.kind === "ping") return reply({ id: data.id, pong: true });
  let runner: PythonCaseRunner;
  try {
    runner = await prepare();
  } catch (error) {
    // Loading failed; the page drops this worker, and the next run starts a fresh one.
    if (data.kind !== "case") return;
    return reply({ id: data.id, ok: false, error: `Python couldn't start: ${error instanceof Error ? error.message : String(error)}`, restart: true });
  }
  if (data.kind !== "case") return;
  try {
    const testCase = ExerciseCaseInput.parse(data.testCase);
    reply({ id: data.id, started: true });
    const run = runner.run({ code: data.code, functionName: data.functionName, testCase });
    reply({ id: data.id, ok: true, run, ...(runner.broken ? { restart: true } : {}) });
  } catch (error) {
    reply({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
