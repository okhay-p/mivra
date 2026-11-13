import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSSyncVariant } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactView,
  CodeExerciseAnswer,
  CodeExerciseInput,
  CodeExerciseSpec,
  EXERCISE_LIMITS,
  artifactKinds,
  casePassed,
  expectedFrom,
  gradeCodeExercise,
  normaliseOutput,
  runExerciseCaseIsolated,
  sameReturnValue,
  toCodeExercisePublic,
  type ExerciseCaseInput,
  type ExerciseLimits,
  type QuickJSModuleFactory,
} from "../src/index.js";
import { addLinesExercise, sumExercise, sumSolution } from "./code-exercise-fixtures.js";

const variant = releaseSync as unknown as QuickJSSyncVariant;
let newModule: QuickJSModuleFactory;
beforeAll(async () => {
  const wasmModule = await WebAssembly.compile(readFileSync(createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm")));
  newModule = (memory) => newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule, wasmMemory: memory }));
});

const run = (code: string, testCase: ExerciseCaseInput, functionName = "f", limits: ExerciseLimits = EXERCISE_LIMITS) =>
  runExerciseCaseIsolated(newModule, { code, functionName, testCase, limits });
const call = (args = "[]"): ExerciseCaseInput => ({ kind: "call", args });
const stdio = (stdin = ""): ExerciseCaseInput => ({ kind: "stdio", stdin });

/** Stored spec for an input, with expected results as the reference would give. */
function specFor(input: CodeExerciseInput, expected: CodeExerciseSpec["cases"][number]["expected"][]): CodeExerciseSpec {
  return CodeExerciseSpec.parse({ ...input, cases: input.cases.map((c, i) => ({ ...c, expected: expected[i] })) });
}

describe("code_exercise schema", () => {
  it("rejects {} as tool input, and accepts the fixtures", () => {
    expect(artifactKinds.code_exercise.input.safeParse({}).success).toBe(false);
    expect(artifactKinds.code_exercise.input.safeParse(sumExercise).success).toBe(true);
    expect(artifactKinds.code_exercise.input.safeParse(addLinesExercise).success).toBe(true);
  });

  it("takes no expected results from the model", () => {
    const withExpected = { ...sumExercise, cases: [{ kind: "call", args: "[[1]]", expected: { returned: "1" } }] };
    expect(CodeExerciseInput.safeParse(withExpected).success).toBe(false);
  });

  it("needs a visible case, a function name for call cases, and JSON-array arguments", () => {
    const issues = (input: unknown) => CodeExerciseInput.safeParse(input).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ ...sumExercise, cases: [{ kind: "call", args: "[[1]]", hidden: true }] })).toContain("at least one case must be visible");
    expect(issues({ ...sumExercise, functionName: undefined })).toContain("functionName is required for call cases");
    expect(issues({ ...sumExercise, cases: [{ kind: "call", args: "{\"a\":1}" }] })).toContain("args must be a JSON array");
    expect(issues({ ...sumExercise, cases: [{ kind: "call", args: "not json" }] })).toContain("args must be a JSON array");
    expect(issues({ ...sumExercise, functionName: "sum(); fetch" })).not.toHaveLength(0);
    expect(issues({ ...sumExercise, language: "python" })).not.toHaveLength(0);
    expect(issues({ ...sumExercise, cases: Array.from({ length: 21 }, () => ({ kind: "call", args: "[]" })) })).not.toHaveLength(0);
  });

  it("keeps the reference and hidden expected results out of the public view", () => {
    const spec = specFor(sumExercise, [{ returned: "6" }, { returned: "0" }, { returned: "10" }]);
    const view = toCodeExercisePublic(spec);
    const json = JSON.stringify(view);
    expect(json).not.toContain("referenceSolution");
    expect(json).not.toContain("total + x");
    expect(json).not.toContain('"10"');
    expect(view.cases.map((c) => [c.hidden, c.expected])).toEqual([
      [false, { returned: "6" }],
      [false, { returned: "0" }],
      [true, undefined],
    ]);
    // The strict wire schema refuses a view that carries the reference.
    const base = { id: "a", createdAt: new Date().toISOString(), kind: "code_exercise", version: 1 };
    expect(ArtifactView.safeParse({ ...base, spec: view }).success).toBe(true);
    expect(ArtifactView.safeParse({ ...base, spec: { ...view, referenceSolution: spec.referenceSolution } }).success).toBe(false);
  });
});

describe("comparing results", () => {
  it("ignores trailing whitespace and trailing blank lines, but not leading spaces", () => {
    expect(normaliseOutput("a  \r\nb\t\n\n\n")).toBe("a\nb");
    expect(casePassed({ stdout: "5" }, { stdout: "5\n\n" })).toBe(true);
    expect(casePassed({ stdout: "5" }, { stdout: " 5\n" })).toBe(false);
  });

  it("compares return values as JSON, ignoring key order", () => {
    expect(sameReturnValue('{"a":1,"b":[1,2]}', '{"b":[1,2],"a":1}')).toBe(true);
    expect(sameReturnValue("[1,2]", "[2,1]")).toBe(false);
    expect(sameReturnValue("undefined", "null")).toBe(false);
    expect(sameReturnValue("undefined", "undefined")).toBe(true);
    expect(casePassed({ returned: "6" }, { stdout: "", returned: "6", error: "boom" })).toBe(false);
  });

  it("refuses to record an expected result from a run that failed", () => {
    expect(() => expectedFrom(call(), { stdout: "", error: "TypeError: x" })).toThrow("TypeError: x");
    expect(expectedFrom(stdio(), { stdout: "3  \n" })).toEqual({ stdout: "3" });
  });
});

describe("grading", () => {
  const spec = specFor(sumExercise, [{ returned: "6" }, { returned: "0" }, { returned: "10" }]);

  it("passes when every case matches, hidden ones included", () => {
    const answer = CodeExerciseAnswer.parse({ code: sumSolution, results: [{ stdout: "", returned: "6" }, { stdout: "", returned: "0" }, { stdout: "", returned: "10" }] });
    expect(gradeCodeExercise(spec, answer)).toEqual({ correct: true, passed: 3, total: 3, cases: [{ passed: true }, { passed: true }, { passed: true }] });
  });

  it("fails a hidden case the learner's code got wrong", () => {
    const answer = CodeExerciseAnswer.parse({ code: "", results: [{ stdout: "", returned: "6" }, { stdout: "", returned: "0" }, { stdout: "", error: "Time limit exceeded" }] });
    expect(gradeCodeExercise(spec, answer)).toMatchObject({ correct: false, passed: 2, total: 3 });
  });

  it("throws when the answer doesn't report every case", () => {
    expect(() => gradeCodeExercise(spec, CodeExerciseAnswer.parse({ code: "", results: [{ stdout: "", returned: "6" }] }))).toThrow(RangeError);
  });
});

describe("running a case in QuickJS", () => {
  it("calls the function with JSON arguments and records its return value", async () => {
    expect(await run(sumSolution, call("[[1, 2, 3]]"), "sum")).toEqual({ stdout: "", returned: "6" });
    expect(await run("const f = (o) => ({ ...o, b: 2 })", call('[{"a":1}]'))).toEqual({ stdout: "", returned: '{"a":1,"b":2}' });
    expect(await run("let f = () => {}", call())).toEqual({ stdout: "", returned: "undefined" });
    expect(await run("async function f() { return 5 }", call())).toEqual({ stdout: "", returned: "5" });
  });

  it("gives a stdio program its input and captures what it prints", async () => {
    const result = await run(addLinesExercise.referenceSolution, stdio("2\n3\n"));
    expect(result).toEqual({ stdout: "5\n" });
    expect(await run("console.log(stdin.length, readLine(), readLine(), [1], { a: 1 }); console.error('debug')", stdio("x\n"))).toEqual({
      stdout: '2 x null [1] {"a":1}\n',
      stderr: "debug\n",
    });
  });

  it("reports errors with their line, and a missing function", async () => {
    expect((await run("\n\nfunction f() { return null.x }", call())).error).toMatch(/^TypeError: .* \(line 3\)$/);
    expect((await run("function g() {}", call())).error).toBe("TypeError: f is not defined as a function");
    expect((await run("syntax error here", stdio())).error).toMatch(/^SyntaxError/);
    expect((await run("function f() { return 1n }", call())).error).toMatch(/can't be recorded as JSON/);
    expect((await run("function f() { return new Promise(() => {}) }", call())).error).toBe("The returned promise never settled.");
  });

  it("exposes no host APIs", async () => {
    const probe = "console.log(typeof fetch, typeof require, typeof process, typeof setTimeout, typeof XMLHttpRequest, typeof __mivra_write, typeof importScripts)";
    expect((await run(probe, stdio())).stdout).toBe("undefined undefined undefined undefined undefined undefined undefined\n");
  });

  it("stops an infinite loop at the time limit", async () => {
    const limits = { ...EXERCISE_LIMITS, timeMs: 200 };
    const started = Date.now();
    expect((await run("function f() { while (true) {} }", call(), "f", limits)).error).toMatch(/^Time limit exceeded/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops runaway memory at the memory limit", async () => {
    const result = await run("function f() { const a = []; while (true) a.push(new Array(100000).fill(1)); }", call());
    expect(result.error).toMatch(/^(Memory|Time) limit exceeded/);
    expect((await run("function f() { return new Array(5e7).fill(1).length }", call())).error).toMatch(/^Memory limit exceeded/);
  });

  it("stops deep recursion and too much output", async () => {
    expect((await run("function f() { return f() }", call())).error).toMatch(/^Stack limit exceeded/);
    expect(await run("function f(n = 0) { return n >= 1000 ? n : f(n + 1) }", call())).toEqual({ stdout: "", returned: "1000" });
    const spam = await run("while (true) console.log('spam')", stdio());
    expect(spam.error).toMatch(/^Output limit exceeded/);
    expect(spam.stdout.length).toBeLessThanOrEqual(EXERCISE_LIMITS.outputChars);
    // One oversized print that ends before the interrupt handler runs still fails.
    for (const code of ['console.log("x".repeat(20001))', 'function f() { console.log("x".repeat(20001)); return 1 }']) {
      expect((await run(code, code.startsWith("function") ? call() : stdio())).error).toMatch(/^Output limit exceeded/);
    }
  });

  it("starts every case fresh", async () => {
    await run("globalThis.leak = 1", stdio());
    expect((await run("console.log(typeof leak)", stdio())).stdout).toBe("undefined\n");
  });
});
