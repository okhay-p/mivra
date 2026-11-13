import { EXERCISE_LIMITS, MAX_CASE_ERROR_CHARS, type ExerciseCaseRun } from "./code-exercise.js";
import { OUTPUT_EXCEEDED, STACK_EXCEEDED, type RunCaseOptions } from "./code-exercise-runner.js";

/**
 * Runs Python exercise cases in Pyodide (ADR-016). The browser's worker and the server's reference check both
 * call this, so the learner's code and the reference run the same way: the same harness, output capture, time
 * limit and messages. The caller loads Pyodide (with `jsglobals: {}`) and keeps it for many cases; this file
 * needs only the few methods below, so it doesn't depend on Pyodide itself.
 *
 * Python can't reach JavaScript once `createPythonCaseRunner` has run: it removes the `js` and `pyodide_js`
 * modules. That isn't a sandbox on its own, since Pyodide can still hand Python a JavaScript object, so each
 * caller also stops strings becoming code (a Content-Security-Policy without 'unsafe-eval' in the browser,
 * `--disallow-code-generation-from-strings` in Node) and removes the network from its global scope.
 *
 * Time is limited through Pyodide's interrupt check, which reads `buffer[0]` every few bytecodes: past the
 * deadline it reads SIGINT and Python raises KeyboardInterrupt, again at every check, so code that catches
 * it still stops. Between cases the deadline stays in the past, so Python that a case left to run later (a
 * callback scheduled through `pyodide.webloop`, say) is interrupted as soon as it starts. A long call into C (a huge `sum(range(...))`) doesn't check, so callers keep a hard limit of
 * their own around a case, as for QuickJS.
 */

export interface PyodideLike {
  runPython(code: string): unknown;
  setInterruptBuffer(buffer: never): void;
  unregisterJsModule(name: string): void;
}

const SIGINT = 2;

const FILENAME = "solution.py";

// Trusted setup, run once per interpreter. Each case gets fresh stdin, stdout, stderr, recursion limit and
// namespace; modules the code imported stay loaded, as they would in one Python process.
const HARNESS = String.raw`
import builtins as _mivra_builtins, io as _mivra_io, json as _mivra_json, sys as _mivra_sys, traceback as _mivra_traceback

for _mivra_name in list(_mivra_sys.modules):
    if _mivra_name == "js" or _mivra_name.startswith("js.") or _mivra_name == "pyodide_js" or _mivra_name.startswith("pyodide_js."):
        del _mivra_sys.modules[_mivra_name]

_mivra_recursion_limit = _mivra_sys.getrecursionlimit()


class _MivraOutputLimit(BaseException):
    pass


class _MivraSink:
    def __init__(self, limit):
        self.limit = limit
        self.parts = ([], [])
        self.used = 0
        self.exceeded = False

    def write(self, stream, text):
        if self.exceeded:
            raise _MivraOutputLimit()
        room = self.limit - self.used
        if len(text) > room:
            self.exceeded = True
            text = text[: max(0, room)]
        self.parts[stream].append(text)
        self.used += len(text)
        if self.exceeded:
            raise _MivraOutputLimit()


class _MivraStream(_mivra_io.TextIOBase):
    def __init__(self, sink, stream):
        self._sink = sink
        self._stream = stream

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError("write() argument must be str, not " + type(text).__name__)
        self._sink.write(self._stream, text)
        return len(text)

    def flush(self):
        pass


def _mivra_describe(error):
    name = type(error).__name__
    text = str(error)
    message = name + ": " + text if text else name
    line = None
    if isinstance(error, SyntaxError) and error.filename == "${FILENAME}":
        line = error.lineno
    for frame, lineno in _mivra_traceback.walk_tb(error.__traceback__):
        if frame.f_code.co_filename == "${FILENAME}":
            line = lineno
    return message + (" (line " + str(line) + ")" if line else "")


def _mivra_run(code, function_name, kind, stdin, args_json, output_limit):
    sink = _MivraSink(output_limit)
    result = {}
    _mivra_sys.setrecursionlimit(_mivra_recursion_limit)
    _mivra_sys.stdin = _mivra_io.StringIO(stdin)
    _mivra_sys.stdout = _MivraStream(sink, 0)
    _mivra_sys.stderr = _MivraStream(sink, 1)
    try:
        namespace = {"__name__": "__main__", "__builtins__": _mivra_builtins}
        exec(compile(code, "${FILENAME}", "exec"), namespace)
        if kind == "call":
            function = namespace.get(function_name)
            if not callable(function):
                raise TypeError(function_name + " is not defined as a function")
            value = function(*_mivra_json.loads(args_json))
            try:
                returned = _mivra_json.dumps(value, allow_nan=False)
            except (TypeError, ValueError) as error:
                result["status"] = "error"
                result["message"] = "The return value can't be recorded as JSON: " + type(error).__name__ + ": " + str(error)
            else:
                if len(returned) > output_limit:
                    result["status"] = "error"
                    result["message"] = "The return value is too large (over {:,} characters).".format(output_limit)
                else:
                    result["returned"] = returned
    except SystemExit as error:
        if kind == "call":
            result["status"] = "error"
            result["message"] = "The code called exit() instead of returning."
        elif error.code not in (None, 0):
            result["status"] = "error"
            result["message"] = "The program exited with status " + str(error.code) + "."
    except _MivraOutputLimit:
        result["status"] = "output"
    except KeyboardInterrupt:
        result["status"] = "time"
    except RecursionError:
        result["status"] = "stack"
    except MemoryError:
        result["status"] = "memory"
    except BaseException as error:
        result["status"] = "error"
        result["message"] = _mivra_describe(error)
    finally:
        _mivra_sys.stdin = _mivra_sys.__stdin__
        _mivra_sys.stdout = _mivra_sys.__stdout__
        _mivra_sys.stderr = _mivra_sys.__stderr__
    result["stdout"] = "".join(sink.parts[0])
    result["stderr"] = "".join(sink.parts[1])
    result["exceeded"] = sink.exceeded
    return _mivra_json.dumps(result)
`;

type HarnessResult = {
  status?: "error" | "output" | "time" | "stack" | "memory";
  message?: string;
  stdout: string;
  stderr: string;
  returned?: string;
  exceeded: boolean;
};

export interface PythonCaseRunner {
  /** Runs one case and reports what it printed, returned or raised. Never throws for anything the code does. */
  run(options: RunCaseOptions): ExerciseCaseRun;
  /** Set once Pyodide itself failed (a fatal error): later cases can't run, so the caller starts a new one. */
  readonly broken: boolean;
}

const timeLimit = (ms: number) => `Time limit exceeded (${ms / 1000} s): the code ran too long, or never stopped.`;

/**
 * Prepares a loaded Pyodide for exercise cases: removes Python's way to JavaScript, installs the harness and
 * the interrupt check. Call it once, before any untrusted code runs.
 */
export function createPythonCaseRunner(pyodide: PyodideLike, { now = Date.now }: { now?: () => number } = {}): PythonCaseRunner {
  // No case is running yet: any Python is interrupted.
  let deadline = Number.NEGATIVE_INFINITY;
  let interrupted = false;
  // Pyodide reads index 0 and writes it back to 0 once it has seen a signal; the write is ignored, so every
  // check after the deadline interrupts again.
  const buffer = new Proxy([0], {
    get(target, key) {
      if (key !== "0") return Reflect.get(target, key);
      if (now() <= deadline) return 0;
      interrupted = true;
      return SIGINT;
    },
    set: () => true,
  });
  for (const name of ["js", "pyodide_js"]) {
    try {
      pyodide.unregisterJsModule(name);
    } catch {
      // Not registered: nothing to remove.
    }
  }
  pyodide.runPython(HARNESS);
  const harness = pyodide.runPython("_mivra_run") as (...args: unknown[]) => string;
  pyodide.setInterruptBuffer(buffer as never);
  let broken = false;

  return {
    get broken() {
      return broken;
    },
    run({ code, functionName, testCase, limits = EXERCISE_LIMITS }) {
      const finish = (run: { stdout?: string; stderr?: string; returned?: string; error?: string }): ExerciseCaseRun => ({
        stdout: run.stdout ?? "",
        ...(run.stderr ? { stderr: run.stderr } : {}),
        ...(run.returned !== undefined ? { returned: run.returned } : {}),
        ...(run.error !== undefined ? { error: run.error.slice(0, MAX_CASE_ERROR_CHARS) } : {}),
      });
      if (broken) return finish({ error: "Python stopped working after an earlier case, so this one couldn't run." });
      interrupted = false;
      deadline = now() + limits.timeMs;
      let raw: string;
      try {
        raw = harness(code, functionName ?? "", testCase.kind, testCase.kind === "stdio" ? testCase.stdin : "", testCase.kind === "call" ? testCase.args : "[]", limits.outputChars);
      } catch (error) {
        // An interrupt landed in the harness itself, or Pyodide failed.
        if (interrupted) return finish({ error: timeLimit(limits.timeMs) });
        const message = error instanceof Error ? error.message : String(error);
        if (/fatal error/i.test(message)) broken = true;
        return finish({ error: /maximum call stack|too much recursion/i.test(message) ? STACK_EXCEEDED : `The code couldn't run: ${message}` });
      } finally {
        deadline = Number.NEGATIVE_INFINITY;
      }
      const result = JSON.parse(raw) as HarnessResult;
      const output = { stdout: result.stdout, stderr: result.stderr };
      // Output past the cap is cut short, so the run can't count even if it finished first.
      if (result.exceeded || result.status === "output") return finish({ ...output, error: OUTPUT_EXCEEDED(limits.outputChars) });
      if (result.status === "time" || interrupted) return finish({ ...output, error: timeLimit(limits.timeMs) });
      if (result.status === "stack") return finish({ ...output, error: STACK_EXCEEDED });
      if (result.status === "memory") return finish({ ...output, error: "Memory limit exceeded: the code used more memory than the browser allows." });
      if (result.status === "error") return finish({ ...output, error: result.message ?? "The code raised an error." });
      return finish({ ...output, returned: result.returned });
    },
  };
}
