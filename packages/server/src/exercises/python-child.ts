import { constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";
import { ExerciseCaseInput, createPythonCaseRunner, type ExerciseCaseRun } from "@mivra/protocol";
import { loadPyodide } from "pyodide";
import { z } from "zod";

/**
 * The entry of a Python reference-check subprocess (see reference-check.ts): runs one exercise's code on its
 * cases in Pyodide, reports what each produced, and exits. The parent starts it with Node's permission model
 * (no file writes, no subprocesses, reads only of its own code and Pyodide's files), with code generation from
 * strings disabled and an empty environment, and kills it if it runs too long. Here Python gets no `js` module
 * (createPythonCaseRunner), Pyodide's file system is in memory only, and the network globals are removed, so the
 * reference can compute and print but can't reach the host or the network.
 */
const Job = z.object({
  code: z.string(),
  functionName: z.string().optional(),
  cases: z.array(ExerciseCaseInput),
});

const send = (message: unknown) => process.send!(message, () => process.exit(0));

/** Pyodide reads a few constants through process.binding, which the permission model refuses. */
async function load() {
  // Deprecated and missing from Node's types, but still what Pyodide calls.
  const host = process as unknown as { binding: (name: string) => unknown };
  const binding = host.binding;
  host.binding = (name) => (name === "constants" ? { fs: fsConstants, os: osConstants } : binding.call(process, name));
  try {
    return await loadPyodide({ jsglobals: {}, env: {}, stdout: () => {}, stderr: () => {} });
  } finally {
    host.binding = binding;
  }
}

/** Nothing below needs these; Pyodide's own Node setup also leaves a global `require` behind. */
function removeGlobals() {
  for (const name of ["require", "fetch", "WebSocket", "EventSource", "XMLHttpRequest", "Request", "Response", "Headers"]) {
    Reflect.deleteProperty(globalThis, name);
  }
  Reflect.deleteProperty(process, "getBuiltinModule");
}

process.once("disconnect", () => process.exit(0));
process.once("message", async (message: unknown) => {
  try {
    const job = Job.parse(message);
    const pyodide = await load();
    removeGlobals();
    const runner = createPythonCaseRunner(pyodide);
    const results: ExerciseCaseRun[] = job.cases.map((testCase) => runner.run({ code: job.code, functionName: job.functionName, testCase }));
    send({ ok: true, results });
  } catch (error) {
    send({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
