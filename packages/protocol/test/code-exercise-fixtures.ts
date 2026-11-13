import type { CodeExerciseInput } from "../src/code-exercise.js";

/** A call-case exercise with one hidden case. */
export const sumExercise: CodeExerciseInput = {
  concept: "array reduce",
  title: "Sum an array",
  instructions: "Write `sum(xs)` that returns the sum of the numbers in `xs`. An empty array sums to 0.",
  language: "javascript",
  starterCode: "function sum(xs) {\n  // Your code here\n}\n",
  functionName: "sum",
  cases: [
    { kind: "call", args: "[[1, 2, 3]]" },
    { kind: "call", args: "[[]]" },
    { kind: "call", args: "[[-5, 5, 10]]", hidden: true },
  ],
  referenceSolution: "function sum(xs) {\n  return xs.reduce((total, x) => total + x, 0);\n}\n",
};

/** A correct answer to sumExercise. */
export const sumSolution = "function sum(xs) {\n  let total = 0;\n  for (const x of xs) total += x;\n  return total;\n}\n";

/** A stdio exercise: read two numbers, one per line, and print their sum. */
export const addLinesExercise: CodeExerciseInput = {
  concept: "reading input",
  title: "Add two lines",
  instructions: "Read two numbers, one per line, and print their sum.",
  language: "javascript",
  starterCode: "const a = Number(readLine());\n",
  cases: [
    { kind: "stdio", stdin: "2\n3\n" },
    { kind: "stdio", stdin: "-1\n1\n", hidden: true },
  ],
  referenceSolution: "const a = Number(readLine());\nconst b = Number(readLine());\nconsole.log(a + b);\n",
};

/** An exercise whose reference throws on one case, so it's refused at creation. */
export const brokenReferenceExercise: CodeExerciseInput = {
  ...sumExercise,
  title: "Broken sum",
  cases: [{ kind: "call", args: "[[1, 2]]" }, { kind: "call", args: "[null]" }],
  referenceSolution: "function sum(xs) { return xs.reduce((a, b) => a + b, 0); }",
};

/** An exercise whose reference never stops. */
export const loopingReferenceExercise: CodeExerciseInput = {
  ...sumExercise,
  title: "Looping sum",
  cases: [{ kind: "call", args: "[[1]]" }],
  referenceSolution: "function sum(xs) { while (true) {} }",
};

/** sumExercise in Python. */
export const pySumExercise: CodeExerciseInput = {
  ...sumExercise,
  title: "Sum a list",
  instructions: "Write `total(xs)` that returns the sum of the numbers in `xs`. An empty list sums to 0.",
  language: "python",
  starterCode: "def total(xs):\n    # Your code here\n    pass\n",
  functionName: "total",
  referenceSolution: "def total(xs):\n    return sum(xs)\n",
};

/** A correct answer to pySumExercise. */
export const pySumSolution = "def total(xs):\n    result = 0\n    for x in xs:\n        result += x\n    return result\n";

/** addLinesExercise in Python. */
export const pyAddLinesExercise: CodeExerciseInput = {
  ...addLinesExercise,
  language: "python",
  starterCode: "a = int(input())\n",
  referenceSolution: "a = int(input())\nb = int(input())\nprint(a + b)\n",
};

/** A Python exercise whose reference never stops. */
export const pyLoopingReferenceExercise: CodeExerciseInput = {
  ...pySumExercise,
  title: "Looping total",
  cases: [{ kind: "call", args: "[[1]]" }],
  referenceSolution: "def total(xs):\n    while True:\n        pass\n",
};
