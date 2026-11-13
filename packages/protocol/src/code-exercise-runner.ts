import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";
import { EXERCISE_LIMITS, MAX_CASE_ERROR_CHARS, type ExerciseCaseInput, type ExerciseCaseRun, type ExerciseLimits } from "./code-exercise.js";

/**
 * Runs one JavaScript exercise case in QuickJS (ADR-016). The browser's worker and the server's reference
 * check both call this, so the learner's code and the reference run the same way. Each case gets a fresh
 * QuickJS instance whose WebAssembly memory has a fixed maximum (QuickJS's own malloc limit can't see block
 * sizes in this build, so it isn't used), a deadline through the interrupt handler, and a stack limit. The
 * guest sees only standard JavaScript plus `console`, the case's `stdin` and `readLine()`: no DOM, network,
 * file system or timers. The caller supplies the QuickJS module, so this file imports only its types.
 *
 * The interrupt handler runs between bytecode instructions, so a long native call (a huge `Array.fill`, say)
 * can overrun the deadline. Callers keep a hard limit of their own around a case: the browser terminates its
 * worker, and the server kills the reference check's process.
 */

const FILENAME = "solution.js";

// Trusted setup, run before the learner's code. Values are shown the same way in both runs, so stdio cases
// compare like with like.
const PRELUDE = `(() => {
  const write = globalThis.__mivra_write;
  const text = globalThis.__mivra_stdin;
  delete globalThis.__mivra_write;
  delete globalThis.__mivra_stdin;
  const show = (value) => {
    if (typeof value === "string") return value;
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (typeof value === "object" && value !== null) {
      if (value instanceof Error) return String(value);
      try { const json = JSON.stringify(value); if (json !== undefined) return json; } catch {}
    }
    return String(value);
  };
  const line = (args) => Array.prototype.map.call(args, show).join(" ");
  const out = function () { write(0, line(arguments)); };
  const err = function () { write(1, line(arguments)); };
  globalThis.console = { log: out, info: out, debug: out, warn: err, error: err };
  const lines = text === "" ? [] : text.replace(/\\r\\n?/g, "\\n").replace(/\\n$/, "").split("\\n");
  let next = 0;
  globalThis.stdin = text;
  globalThis.readLine = () => (next < lines.length ? lines[next++] : null);
})();`;

const SERIALISE = `(value) => {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  return json === undefined ? "undefined" : json;
}`;

export interface RunCaseOptions {
  code: string;
  functionName?: string;
  testCase: ExerciseCaseInput;
  limits?: ExerciseLimits;
  /** The clock, for tests. */
  now?: () => number;
}

class Capped {
  stdout = "";
  stderr = "";
  exceeded = false;
  constructor(private readonly limit: number) {}
  write(stream: number, text: string) {
    if (this.exceeded) return;
    const line = `${text}\n`;
    const room = this.limit - this.stdout.length - this.stderr.length;
    if (line.length > room) this.exceeded = true;
    const kept = line.slice(0, Math.max(0, room));
    if (stream === 0) this.stdout += kept;
    else this.stderr += kept;
  }
}

const STACK_EXCEEDED = "Stack limit exceeded: the code recursed too deeply.";
const formatBytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Runs one case and reports what it printed, returned or threw. Never throws for anything the guest does. */
export function runExerciseCase(module: QuickJSWASMModule, { code, functionName, testCase, limits = EXERCISE_LIMITS, now = Date.now }: RunCaseOptions): ExerciseCaseRun {
  const output = new Capped(limits.outputChars);
  const deadline = now() + limits.timeMs;
  let timedOut = false;
  const runtime = module.newRuntime();
  runtime.setMaxStackSize(limits.stackBytes);
  runtime.setInterruptHandler(() => {
    if (now() > deadline) timedOut = true;
    return timedOut || output.exceeded;
  });

  const describe = (vm: QuickJSContext, handle: QuickJSHandle): string => {
    if (timedOut) return `Time limit exceeded (${limits.timeMs / 1000} s): the code ran too long, or never stopped.`;
    if (output.exceeded) return `Output limit exceeded (${limits.outputChars.toLocaleString("en-US")} characters).`;
    let message = "The code threw an error.";
    try {
      const dumped = vm.dump(handle) as unknown;
      if (dumped && typeof dumped === "object" && "message" in dumped) {
        const { name, message: text, stack } = dumped as { name?: unknown; message?: unknown; stack?: unknown };
        message = `${typeof name === "string" ? name : "Error"}: ${String(text)}`;
        const line = typeof stack === "string" ? new RegExp(`${FILENAME.replace(".", "\\.")}:(\\d+)`).exec(stack)?.[1] : undefined;
        if (line) message += ` (line ${line})`;
      } else {
        message = `Uncaught ${typeof dumped === "string" ? dumped : JSON.stringify(dumped) ?? String(dumped)}`;
      }
    } catch {
      // The context may be unusable after running out of memory.
    }
    return friendly(message);
  };
  const friendly = (message: string) => {
    if (/out of memory/i.test(message)) return `Memory limit exceeded (${formatBytes(limits.memoryBytes)}).`;
    if (/stack overflow|call stack size/i.test(message)) return STACK_EXCEEDED;
    return message;
  };

  const finish = (result: { returned?: string; error?: string }): ExerciseCaseRun => ({
    stdout: output.stdout,
    ...(output.stderr ? { stderr: output.stderr } : {}),
    ...(result.returned !== undefined ? { returned: result.returned } : {}),
    ...(result.error !== undefined ? { error: result.error.slice(0, MAX_CASE_ERROR_CHARS) } : {}),
  });

  let vm: QuickJSContext | undefined;
  try {
    vm = runtime.newContext();
    const context = vm;
    const write = context.newFunction("__mivra_write", (stream, text) => {
      output.write(context.getNumber(stream), context.getString(text));
    });
    context.setProp(context.global, "__mivra_write", write);
    write.dispose();
    const stdin = context.newString(testCase.kind === "stdio" ? testCase.stdin : "");
    context.setProp(context.global, "__mivra_stdin", stdin);
    stdin.dispose();

    // Runs code, then any promise jobs it queued; returns the result's handle, or an error message.
    const evaluate = (source: string, filename: string): { value: QuickJSHandle } | { error: string } => {
      const result = context.evalCode(source, filename);
      if (result.error) {
        const error = describe(context, result.error);
        result.error.dispose();
        return { error };
      }
      return { value: result.value };
    };
    const settle = (handle: QuickJSHandle): { value: QuickJSHandle } | { error: string } => {
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const error = describe(context, jobs.error);
          jobs.error.dispose();
          handle.dispose();
          return { error };
        }
        const state = context.getPromiseState(handle);
        if (state.type === "fulfilled") {
          if (state.notAPromise) return { value: handle };
          handle.dispose();
          return { value: state.value };
        }
        if (state.type === "rejected") {
          const error = describe(context, state.error);
          state.error.dispose();
          handle.dispose();
          return { error };
        }
        if (jobs.value === 0) {
          handle.dispose();
          return { error: timedOut ? describe(context, context.undefined) : "The returned promise never settled." };
        }
      }
    };

    const prelude = context.evalCode(PRELUDE, "prelude.js");
    if (prelude.error) {
      const error = describe(context, prelude.error);
      prelude.error.dispose();
      return finish({ error });
    }
    prelude.value.dispose();

    const ran = evaluate(code, FILENAME);
    if ("error" in ran) return finish(ran);
    const program = settle(ran.value);
    if ("error" in program) return finish(program);
    program.value.dispose();
    if (testCase.kind === "stdio") return finish({});

    const name = functionName ?? "";
    const call = evaluate(
      `typeof ${name} === "function" ? ${name}(...JSON.parse(${JSON.stringify(testCase.args)})) : (() => { throw new TypeError(${JSON.stringify(`${name} is not defined as a function`)}); })()`,
      "call.js",
    );
    if ("error" in call) return finish(call);
    const value = settle(call.value);
    if ("error" in value) return finish(value);
    const serialise = evaluate(SERIALISE, "serialise.js");
    if ("error" in serialise) {
      value.value.dispose();
      return finish(serialise);
    }
    const json = context.callFunction(serialise.value, context.undefined, value.value);
    serialise.value.dispose();
    value.value.dispose();
    if (json.error) {
      const error = `The return value can't be recorded as JSON: ${describe(context, json.error)}`;
      json.error.dispose();
      return finish({ error });
    }
    const returned = context.getString(json.value);
    json.value.dispose();
    if (returned.length > limits.outputChars) return finish({ error: `The return value is too large (over ${limits.outputChars.toLocaleString("en-US")} characters).` });
    return finish({ returned });
  } catch (error) {
    // QuickJS itself failed, e.g. memory ran out while setting up. Report it as the case's error.
    const message = error instanceof Error ? error.message : String(error);
    const known = friendly(message);
    return finish({ error: known !== message ? known : timedOut ? `Time limit exceeded (${limits.timeMs / 1000} s).` : `The code couldn't run: ${message}` });
  } finally {
    try {
      vm?.dispose();
      runtime.dispose();
    } catch {
      // A runtime that ran out of memory can fail its own clean-up; it's dropped either way.
    }
  }
}

/** WebAssembly pages are 64 KiB. QuickJS's build starts with 16 MiB. */
const PAGE_BYTES = 64 * 1024;
const INITIAL_PAGES = 256;

/** Makes a QuickJS module whose WebAssembly instance uses the given memory (see `newVariant`'s `wasmMemory`). */
export type QuickJSModuleFactory = (memory: WebAssembly.Memory) => Promise<QuickJSWASMModule>;

/**
 * Runs one case in its own QuickJS instance, whose memory can't grow past `limits.memoryBytes`. The instance
 * is dropped afterwards, so nothing a case did (or broke) carries over to the next.
 */
export async function runExerciseCaseIsolated(newModule: QuickJSModuleFactory, options: RunCaseOptions): Promise<ExerciseCaseRun> {
  const limits = options.limits ?? EXERCISE_LIMITS;
  const maximum = Math.max(INITIAL_PAGES, Math.floor(limits.memoryBytes / PAGE_BYTES));
  const module = await newModule(new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum }));
  return runExerciseCase(module, { ...options, limits });
}
