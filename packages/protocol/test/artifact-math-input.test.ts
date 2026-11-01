import { describe, expect, it } from "vitest";
import { z } from "zod";
import { artifactKinds, artifactMathInput, splitMath } from "../src/index.js";

const bare = String.raw`\displaystyle\sum_{i=1}^{n} i`;
const textInput = artifactMathInput(z.object({ text: z.string() }), ["text"]);

describe("artifact math input", () => {
  it.each(Object.values(artifactKinds))("keeps $toolName input schemas usable as required JSON objects", (definition) => {
    expect(definition.input.safeParse({}).success).toBe(false);
    const schema = z.toJSONSchema(definition.input);
    expect(schema.type).toBe("object");
    expect(schema.required?.length).toBeGreaterThan(0);
    expect(schema.additionalProperties).toBe(false);
  });

  it.each([
    bare, `$ ${bare}$`, `$${bare} $`, `$$${bare}$$`, `$${bare}$2`,
    String.raw`\$\sum$`, String.raw`$x` + "`" + String.raw`\sum$`,
    String.raw`C:\Users\fixture`, String.raw`A\B`, String.raw`use \setminus`,
    String.raw`code: \n`, "`" + String.raw`\alpha` + "`",
  ])("rejects commands rendered literally: %s", (text) => {
    expect(textInput.safeParse({ text }).success).toBe(false);
  });

  it.each([
    `$${bare}$`, String.raw`$\text{cost \$5}$`, String.raw`cost \$5 and $\alpha$`,
    String.raw`$x\\$ and $\sum_i i$`, "A ∖ B", "A \\ B", "C:/Users/fixture", "v_0", "costs $5 and $10",
  ])("accepts delimited math and unambiguous literals: %s", (text) => {
    expect(textInput.safeParse({ text }).success).toBe(true);
  });

  it("uses exactly the renderer's math pieces, including escaped dollars", () => {
    expect(splitMath(String.raw`cost \$5; $\alpha$`)).toEqual([{ text: "cost $5; " }, { formula: String.raw`\alpha` }]);
  });

  it("checks every math-mode field, leaving old stored specs readable", () => {
    const examples = [
      ["algorithm_trace", { title: "Trace", values: [1], steps: [{ explanation: "Step" }] }, ["title", "steps.0.explanation"]],
      ["graph", { title: "Graph", directed: true, nodes: [{ id: "a" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "Edge" }], steps: [{ explanation: "Step" }] }, ["title", "nodes.1.label", "edges.0.label", "steps.0.explanation"]],
      ["multiple_choice", { concept: "Math", question: "Q", options: [{ text: "A", feedback: "Feedback" }, { text: "B" }], correctOptionIndex: 0, explanation: "Explain" }, ["question", "options.0.text", "options.0.feedback", "explanation"]],
      ["set_diagram", { title: "Sets", universe: "U", sets: [{ id: "a", label: "A" }], regions: [{ in: ["a"], elements: ["x"] }], steps: [{ explanation: "Step", variables: [{ name: "n", value: "x" }] }] }, ["title", "universe", "sets.0.label", "regions.0.elements.0", "steps.0.explanation", "steps.0.variables.0.name", "steps.0.variables.0.value"]],
      ["table", { title: "Table", columns: ["C"], rows: [["x"]], rowHeaders: ["R"], steps: [{ explanation: "Step", cells: [{ row: 0, column: 0, value: "y" }] }] }, ["title", "columns.0", "rows.0.0", "rowHeaders.0", "steps.0.explanation", "steps.0.cells.0.value"]],
      ["worked_steps", { title: "Proof", goal: "Goal", steps: [{ label: "Base", statement: "Claim", justification: "Reason" }] }, ["title", "goal", "steps.0.label", "steps.0.statement", "steps.0.justification"]],
    ] as const;
    for (const [kind, example, paths] of examples) {
      const definition = artifactKinds[kind];
      expect(definition.input.safeParse(example).success).toBe(true);
      for (const path of paths) {
        const spec = structuredClone(example);
        const keys = path.split(".");
        let parent = spec as unknown as Record<string, unknown>;
        for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
        parent[keys.at(-1)!] = String.raw`\alpha`;
        expect(definition.spec.safeParse(spec).success, `${kind}.${path} legacy`).toBe(true);
        const result = definition.input.safeParse(spec);
        expect(result.success, `${kind}.${path}`).toBe(false);
        if (!result.success) expect(result.error.issues.some((issue) => issue.path.join(".") === path && issue.message.includes("Wrap LaTeX commands"))).toBe(true);
      }
    }
  });

  it("checks a graph's fallback id only when it is rendered as the label", () => {
    const spec = { title: "G", directed: false, nodes: [{ id: String.raw`\alpha` }], edges: [] };
    expect(artifactKinds.graph.input.safeParse(spec).success).toBe(false);
    expect(artifactKinds.graph.input.safeParse({ ...spec, nodes: [{ ...spec.nodes[0], label: "$a$" }] }).success).toBe(true);
  });

  it("leaves plain-mode fields alone", () => {
    expect(artifactKinds.algorithm_trace.input.safeParse({ title: "Trace", values: [String.raw`\alpha`], steps: [{ explanation: "Step", variables: [{ name: String.raw`\alpha`, value: String.raw`\alpha` }] }] }).success).toBe(true);
  });
});
