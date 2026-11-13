import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vitest";
import { CodeExerciseInput, EXERCISE_LIMITS, createPythonCaseRunner, type ExerciseCaseInput, type ExerciseLimits, type PythonCaseRunner } from "../src/index.js";
import { pySumExercise } from "./code-exercise-fixtures.js";

// Loading Pyodide compiles a large WebAssembly module and starts Python, which takes a while on a busy machine.
let runner: PythonCaseRunner;
beforeAll(async () => {
  const pyodide = await loadPyodide({ jsglobals: {}, env: {}, stdout: () => {}, stderr: () => {} });
  runner = createPythonCaseRunner(pyodide);
}, 120_000);

const run = (code: string, testCase: ExerciseCaseInput, functionName = "f", limits: ExerciseLimits = EXERCISE_LIMITS) =>
  runner.run({ code, functionName, testCase, limits });
const call = (args = "[]"): ExerciseCaseInput => ({ kind: "call", args });
const stdio = (stdin = ""): ExerciseCaseInput => ({ kind: "stdio", stdin });

describe("the Python exercise schema", () => {
  it("accepts Python and checks functionName is a Python identifier", () => {
    expect(CodeExerciseInput.safeParse(pySumExercise).success).toBe(true);
    expect(CodeExerciseInput.safeParse({ ...pySumExercise, functionName: "$sum" }).success).toBe(false);
    expect(CodeExerciseInput.safeParse({ ...pySumExercise, functionName: "lambda" }).success).toBe(false);
    expect(CodeExerciseInput.safeParse({ ...pySumExercise, language: "javascript", functionName: "$sum" }).success).toBe(true);
  });
});

describe("the Python case runner", () => {
  it("calls the function with JSON arguments and records its return value as JSON", () => {
    expect(run("def f(xs, n):\n    return {'n': n, 'xs': tuple(xs), 'none': None}\n", call('[[1, 2], 2.5]'))).toEqual({
      stdout: "",
      returned: '{"n": 2.5, "xs": [1, 2], "none": null}',
    });
  });

  it("feeds stdin to input() and sys.stdin, and captures print and stderr apart", () => {
    const code = "import sys\na = int(input())\nrest = sys.stdin.read().split()\nprint(a + sum(map(int, rest)))\nprint('note', file=sys.stderr)\n";
    expect(run(code, stdio("1\n2 3\n"))).toEqual({ stdout: "6\n", stderr: "note\n" });
  });

  it("reports an exception with its line, and a syntax error", () => {
    expect(run("def f():\n    return 1 // 0\n", call()).error).toBe("ZeroDivisionError: division by zero (line 2)");
    expect(run("def f(:\n", call()).error).toMatch(/^SyntaxError: .*\(line 1\)$/);
    expect(run("g = 1\n", call()).error).toBe("TypeError: f is not defined as a function");
  });

  it("refuses a return value JSON can't hold", () => {
    expect(run("def f():\n    return {1, 2}\n", call()).error).toMatch(/^The return value can't be recorded as JSON: TypeError/);
    expect(run("def f():\n    return float('nan')\n", call()).error).toMatch(/^The return value can't be recorded as JSON: ValueError/);
  });

  it("treats exit(0) in a program as finishing, and other exits as errors", () => {
    expect(run("print('a')\nexit()\nprint('b')\n", stdio())).toEqual({ stdout: "a\n" });
    expect(run("import sys\nsys.exit(3)\n", stdio()).error).toBe("The program exited with status 3.");
    expect(run("import sys\nsys.exit()\ndef f():\n    return 1\n", call()).error).toBe("The code called exit() instead of returning.");
  });

  it("stops an infinite loop at the time limit, even one that catches the interrupt, and runs the next case", () => {
    const limits = { ...EXERCISE_LIMITS, timeMs: 300 };
    expect(run("while True:\n    pass\n", stdio(), "f", limits).error).toMatch(/^Time limit exceeded \(0\.3 s\)/);
    const stubborn = "for _ in range(3):\n    try:\n        while True:\n            pass\n    except KeyboardInterrupt:\n        pass\n";
    expect(run(stubborn, stdio(), "f", limits).error).toMatch(/^Time limit exceeded/);
    expect(run("print('ok')\n", stdio())).toEqual({ stdout: "ok\n" });
  });

  it("caps output and fails the case, even if it finishes", () => {
    const limits = { ...EXERCISE_LIMITS, outputChars: 10 };
    const capped = run("print('x' * 50)\n", stdio(), "f", limits);
    expect(capped.stdout).toBe("x".repeat(10));
    expect(capped.error).toBe("Output limit exceeded (10 characters).");
    expect(run("while True:\n    try:\n        print('spam')\n    except BaseException:\n        pass\n", stdio(), "f", { ...limits, timeMs: 500 }).error).toMatch(/limit exceeded/);
  });

  it("reports deep recursion as a stack limit", () => {
    expect(run("def f():\n    return f()\n", call()).error).toBe("Stack limit exceeded: the code recursed too deeply.");
  });

  it("starts each case with a fresh namespace, stdin and output", () => {
    run("import sys\nsys.setrecursionlimit(50)\ncounter = 5\n", stdio());
    expect(run("print(globals().get('counter'))\nimport sys\nprint(sys.getrecursionlimit() > 50)\n", stdio())).toEqual({ stdout: "None\nTrue\n" });
  });

  it("gives Python no way to JavaScript", () => {
    expect(run("import js\n", stdio()).error).toMatch(/^ModuleNotFoundError: No module named 'js'/);
    expect(run("import pyodide_js\n", stdio()).error).toMatch(/^ModuleNotFoundError: No module named 'pyodide_js'/);
    expect(run("from pyodide.code import run_js\nrun_js('1')\n", stdio()).error).toMatch(/^ModuleNotFoundError/);
  });
});
