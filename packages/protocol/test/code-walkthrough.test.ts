import { describe, expect, it } from "vitest";
import { ArtifactView, CodeWalkthroughSpec, GraphSpec, LessonSectionKind, MAX_CODE_LINES, artifactKinds, kindForTool } from "../src/index.js";
import { componentTree, counterWalkthrough, functionWalkthrough } from "./code-learning-fixtures.js";

const issues = (spec: unknown) => CodeWalkthroughSpec.safeParse(spec).error?.issues.map((issue) => issue.message).join("; ") ?? "";
const withStep = (step: object) => ({ ...functionWalkthrough, steps: [{ explanation: "x", variables: [], output: "", ...step }] });

describe("code_walkthrough", () => {
  it("accepts a plain function and a React counter, with no values array", () => {
    expect(CodeWalkthroughSpec.parse(functionWalkthrough)).toEqual(functionWalkthrough);
    expect(CodeWalkthroughSpec.parse(counterWalkthrough)).toEqual(counterWalkthrough);
    expect(artifactKinds.code_walkthrough.input.safeParse(counterWalkthrough).success).toBe(true);
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, values: [1] }).success).toBe(false);
  });

  it("is registered as show_code_walkthrough v1, as a lesson section kind and in the view union", () => {
    expect(kindForTool("show_code_walkthrough")).toBe("code_walkthrough");
    expect(artifactKinds.code_walkthrough.version).toBe(1);
    expect(LessonSectionKind.safeParse("code_walkthrough").success).toBe(true);
    const view = { id: "a", createdAt: "2026-11-11T00:00:00.000Z", kind: "code_walkthrough", version: 1, spec: counterWalkthrough };
    expect(ArtifactView.safeParse(view).success).toBe(true);
    expect(ArtifactView.safeParse({ ...view, spec: { ...counterWalkthrough, steps: [] } }).success).toBe(false);
  });

  it("rejects {}, unknown fields and missing required parts", () => {
    expect(CodeWalkthroughSpec.safeParse({}).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, extra: 1 }).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ extra: 1 })).success).toBe(false);
    const { code: _code, ...noCode } = functionWalkthrough;
    expect(CodeWalkthroughSpec.safeParse(noCode).success).toBe(false);
    // variables and output are part of every snapshot: nothing is inherited, so neither may be left out.
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, steps: [{ explanation: "x", output: "" }] }).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, steps: [{ explanation: "x", variables: [] }] }).success).toBe(false);
  });

  it("bounds the title, steps, explanation, label, variables and output", () => {
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, title: " " }).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, title: "t".repeat(121) }).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, steps: [] }).success).toBe(false);
    const step = { explanation: "x", variables: [], output: "" };
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, steps: Array(200).fill(step) }).success).toBe(true);
    expect(CodeWalkthroughSpec.safeParse({ ...functionWalkthrough, steps: Array(201).fill(step) }).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ explanation: " " })).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ explanation: "e".repeat(501) })).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ label: "" })).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ label: "l".repeat(80) })).success).toBe(true);
    expect(CodeWalkthroughSpec.safeParse(withStep({ label: "l".repeat(81) })).success).toBe(false);
    const vars = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `v${i}`, value: i }));
    expect(CodeWalkthroughSpec.safeParse(withStep({ variables: vars(12) })).success).toBe(true);
    expect(CodeWalkthroughSpec.safeParse(withStep({ variables: vars(13) })).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ output: "o".repeat(4000) })).success).toBe(true);
    expect(CodeWalkthroughSpec.safeParse(withStep({ output: "o".repeat(4001) })).success).toBe(false);
  });

  it("keeps empty output valid and preserves the output's whitespace and newlines", () => {
    const output = "  Count: 1\n\n\tdone  \n";
    expect(CodeWalkthroughSpec.parse(withStep({ output: "" })).steps[0]!.output).toBe("");
    expect(CodeWalkthroughSpec.parse(withStep({ output })).steps[0]!.output).toBe(output);
  });

  it("rejects duplicate variable names within a step, but not across steps", () => {
    expect(issues(withStep({ variables: [{ name: "count", value: 0 }, { name: " count ", value: 1 }] }))).toMatch(/"count" appears twice/);
    expect(CodeWalkthroughSpec.safeParse(counterWalkthrough).success).toBe(true);
  });

  it("rejects lines outside the source, below 1 or not whole, and allows none", () => {
    // functionWalkthrough's source has 5 lines; its trailing newline adds none.
    expect(issues(withStep({ lines: [6] }))).toMatch(/line 6 is outside the code \(5 lines\)/);
    expect(CodeWalkthroughSpec.safeParse(withStep({ lines: [0] })).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ lines: [1.5] })).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ lines: Array(MAX_CODE_LINES + 1).fill(1) })).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(withStep({ lines: [] })).success).toBe(true);
    expect(CodeWalkthroughSpec.safeParse(withStep({})).success).toBe(true);
  });

  it("numbers lines the way the code pane does: CRLF is one break and a trailing newline adds no line", () => {
    const crlf = { ...functionWalkthrough, code: { language: "Python", source: "a\r\nb\r\n" } };
    expect(CodeWalkthroughSpec.safeParse({ ...crlf, steps: [{ explanation: "x", lines: [2], variables: [], output: "" }] }).success).toBe(true);
    expect(CodeWalkthroughSpec.safeParse({ ...crlf, steps: [{ explanation: "x", lines: [3], variables: [], output: "" }] }).success).toBe(false);
  });

  it("reuses the trace's code limits", () => {
    const code = (source: string) => ({ ...functionWalkthrough, code: { language: "Python", source }, steps: [{ explanation: "x", variables: [], output: "" }] });
    expect(CodeWalkthroughSpec.safeParse(code(Array(MAX_CODE_LINES + 1).fill("x").join("\n"))).success).toBe(false);
    expect(CodeWalkthroughSpec.safeParse(code("\n  \n")).success).toBe(false);
  });

  it("keeps code, variables and output literal: HTML, JS, backslashes and dollars are not maths errors", () => {
    const spec = {
      ...functionWalkthrough,
      code: { language: "JSX", source: 'const price = "$5";\nel.innerHTML = "<b>C:\\Users</b>";' },
      steps: [{ explanation: "It costs \\$5.", lines: [1, 2], variables: [{ name: "price", value: "$5 \\frac" }], output: "<script>alert(1)</script> $x$ \\alpha" }],
    };
    expect(artifactKinds.code_walkthrough.input.safeParse(spec).success).toBe(true);
    // Title and explanation are maths-enabled like other artifacts', so a bare TeX command there is still rejected.
    expect(artifactKinds.code_walkthrough.input.safeParse({ ...spec, steps: [{ ...spec.steps[0], explanation: "Uses \\frac here" }] }).success).toBe(false);
  });

  it("tells the tutor when to use it instead of a trace or graph, and that snapshots are complete and illustrative", () => {
    const { description } = artifactKinds.code_walkthrough;
    expect(description).toMatch(/show_algorithm_trace instead/);
    expect(description).toMatch(/show_graph for a component hierarchy/);
    expect(description).toMatch(/nothing carries over/);
    expect(description).toMatch(/not a real run/);
    expect(description).toMatch(/queued update/);
    expect(artifactKinds.algorithm_trace.description).toMatch(/show_code_walkthrough instead of inventing an array/);
  });
});

describe("component trees on the existing graph kind (#99)", () => {
  it("accepts App → Counter → CounterLabel as a directed tree with prop labels and step highlights", () => {
    expect(GraphSpec.parse(componentTree)).toEqual(componentTree);
    expect(artifactKinds.graph.input.safeParse(componentTree).success).toBe(true);
  });

  it("gives two instances of one component distinct ids", () => {
    const twice = {
      ...componentTree,
      nodes: [...componentTree.nodes, { id: "label2", label: "CounterLabel" }],
      edges: [...componentTree.edges, { from: "counter", to: "label2", label: "count" }],
    };
    expect(GraphSpec.safeParse(twice).success).toBe(true);
    expect(GraphSpec.safeParse({ ...twice, nodes: [...componentTree.nodes, { id: "label", label: "CounterLabel" }] }).success).toBe(false);
  });

  it("tells the tutor how to draw a component hierarchy and keep it fixed", () => {
    const { description } = artifactKinds.graph;
    expect(description).toMatch(/component hierarchy/);
    expect(description).toMatch(/one node per component instance/);
    expect(description).toMatch(/don't add callback edges/);
    expect(description).toMatch(/re-renders/);
  });
});

describe("prediction checks (#99)", () => {
  it("tells the tutor the snippet goes in the reply text, never as code fences in the check", () => {
    expect(artifactKinds.multiple_choice.description).toMatch(/fenced code block in your reply text/);
    expect(artifactKinds.multiple_choice.description).toMatch(/never put code fences in them/);
  });
});
