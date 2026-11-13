import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import { EXERCISE_LIMITS, ExerciseCaseInput, runExerciseCaseIsolated, type ExerciseCaseRun } from "@mivra/protocol";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSSyncVariant } from "quickjs-emscripten-core";
import { z } from "zod";

/**
 * The entry of a reference-check subprocess (see reference-check.ts): runs one exercise's code on its cases in
 * QuickJS, reports what each produced, and exits. The code only ever runs inside QuickJS, which has no file
 * system, network or host objects; this process adds a heap limit, an empty environment and a parent that
 * kills it when it runs too long.
 */
const Job = z.object({
  code: z.string(),
  functionName: z.string().optional(),
  cases: z.array(ExerciseCaseInput),
});

// The package's types describe its CommonJS build; the default export is the sync variant.
const variant = releaseSync as unknown as QuickJSSyncVariant;

const send = (message: unknown) => process.send!(message, () => process.exit(0));

process.once("disconnect", () => process.exit(0));
process.once("message", async (message: unknown) => {
  try {
    const job = Job.parse(message);
    const wasm = await readFile(createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm"));
    const wasmModule = await WebAssembly.compile(wasm);
    const newModule = (memory: WebAssembly.Memory) => newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule, wasmMemory: memory }));
    const results: ExerciseCaseRun[] = [];
    for (const testCase of job.cases) {
      results.push(await runExerciseCaseIsolated(newModule, { code: job.code, functionName: job.functionName, testCase, limits: EXERCISE_LIMITS }));
    }
    send({ ok: true, results });
  } catch (error) {
    send({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
