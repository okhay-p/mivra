/// <reference lib="webworker" />
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import wasmUrl from "@jitl/quickjs-wasmfile-release-sync/wasm?url";
import { ExerciseCaseInput, runExerciseCaseIsolated, type ExerciseCaseRun } from "@mivra/protocol";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSSyncVariant } from "quickjs-emscripten-core";

/**
 * Runs exercise cases in QuickJS (ADR-016), one case per message, so the page can time each case and terminate this
 * worker if one overruns. QuickJS's WebAssembly file is one of Mivra's own built assets, so this works offline. The
 * worker gets only the exercise's code and one case: never the API token or anything else from the page. The code
 * runs inside QuickJS, which has no DOM, network or timers; this worker's own `fetch` is only used to load QuickJS
 * before any code runs.
 */

export type ExerciseWorkerRequest = { id: number; code: string; functionName?: string; testCase: ExerciseCaseInput };
export type ExerciseWorkerResponse = { id: number; ok: true; run: ExerciseCaseRun } | { id: number; ok: false; error: string };

const variant = releaseSync as unknown as QuickJSSyncVariant;
let compiled: Promise<WebAssembly.Module> | undefined;
const wasmModule = () => (compiled ??= fetch(wasmUrl).then((res) => res.arrayBuffer()).then((bytes) => WebAssembly.compile(bytes)));

self.onmessage = async ({ data }: MessageEvent<ExerciseWorkerRequest>) => {
  const reply = (message: ExerciseWorkerResponse) => self.postMessage(message);
  try {
    const testCase = ExerciseCaseInput.parse(data.testCase);
    const module = await wasmModule();
    const run = await runExerciseCaseIsolated((memory) => newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule: module, wasmMemory: memory })), {
      code: data.code,
      functionName: data.functionName,
      testCase,
    });
    reply({ id: data.id, ok: true, run });
  } catch (error) {
    compiled = undefined;
    reply({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
