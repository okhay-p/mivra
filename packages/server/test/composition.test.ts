import { CompositionArtifactView, LessonOutlineInput, type CompositionSpec } from "@mivra/protocol";
import { describe, expect, it } from "vitest";
import { coreCourse } from "../src/plugins/core-course.js";
import { coreLearning } from "../src/plugins/core-learning.js";
import { coreMemory } from "../src/plugins/core-memory.js";
import { compositionKindDefinition, compositionView } from "../src/plugins/composition.js";
import { createCapabilityRegistry } from "../src/runtime/capabilities.js";

/** Two names sharing one list, cut down from the protocol package's aliasing fixture. */
const aliasingComposition = {
  title: "Two names, one list",
  groups: [{ id: "names", label: "Names", ordered: false }, { id: "heap", label: "Objects", ordered: false }],
  entities: [
    { id: "a", label: "a", properties: [] },
    { id: "b", label: "b", properties: [] },
    { id: "list", label: "list", properties: [{ name: "length", value: 3 }], body: [{ type: "code", language: "Python", code: "[1, 2, 3]" }] },
  ],
  connections: [{ id: "a_list", from: "a", to: "list" }, { id: "b_list", from: "b", to: "list", label: "alias" }],
  steps: [
    { label: "a = [1, 2, 3]", explanation: "a refers to a new list.", placements: [{ groupId: "names", entityIds: ["a"] }, { groupId: "heap", entityIds: ["list"] }], hidden: ["b"], connections: ["a_list"] },
    {
      label: "b = a",
      explanation: "b refers to the same list.",
      placements: [{ groupId: "names", entityIds: ["a", "b"] }, { groupId: "heap", entityIds: ["list"] }],
      hidden: [],
      connections: ["a_list", "b_list"],
      state: [{ entityId: "list", properties: [{ name: "length", value: 3 }, { name: "names", value: 2 }] }],
      emphasis: [{ entityId: "b", tone: "active" }],
      callouts: [{ entityId: "list", text: "One object, two names." }],
    },
  ],
} satisfies CompositionSpec;

describe("composition's server contract", () => {
  const createdAt = new Date("2026-11-13T00:00:00.000Z");

  it("projects a stored composition to a strict view of the whole spec", () => {
    const view = compositionView({ id: "c1", createdAt, spec: aliasingComposition });
    expect(view).toEqual({ id: "c1", createdAt: "2026-11-13T00:00:00.000Z", kind: "composition", version: 1, spec: aliasingComposition });
    expect(CompositionArtifactView.parse(view)).toEqual(view);
  });

  it("refuses to project a spec with anything outside the schema", () => {
    expect(() => compositionView({ id: "c1", createdAt, spec: {} })).toThrow();
    expect(() => compositionView({ id: "c1", createdAt, spec: { ...aliasingComposition, answerKey: "private" } })).toThrow();
  });

  it("still projects a stored spec that would fail today's authoring checks", () => {
    const stored = { ...aliasingComposition, title: String.raw`Bare \alpha` };
    expect(compositionKindDefinition.spec.safeParse(stored).success).toBe(false);
    expect(compositionView({ id: "c1", createdAt, spec: stored }).spec.title).toBe(stored.title);
  });

  it("is a show_composition v1 definition with no check, so viewing records no attempt or evidence", () => {
    expect(compositionKindDefinition).toMatchObject({ kind: "composition", version: 1, toolName: "show_composition" });
    expect(compositionKindDefinition).not.toHaveProperty("check");
    expect(compositionKindDefinition.spec.safeParse(aliasingComposition).success).toBe(true);
    expect(compositionKindDefinition.spec.safeParse({}).success).toBe(false);
  });

  // Flip this when #113 registers the kind: see the activation steps on compositionArtifactKind.
  it("stays dormant: the default plugins neither register the kind nor offer its tool", () => {
    const registry = createCapabilityRegistry([coreLearning, coreMemory, coreCourse]);
    expect(registry.artifactKind("composition")).toBeUndefined();
    expect(registry.artifactKindForTool("show_composition")).toBeUndefined();
    const { tools } = createCapabilityRegistry([coreLearning]).toolsFor({ sessionId: "s", runId: "r", store: {} as never });
    expect(Object.keys(tools)).toContain("show_graph");
    expect(Object.keys(tools)).not.toContain("show_composition");
    const outline = { title: "t", sections: [{ title: "a", kind: "composition", purpose: "p" }, { title: "b", kind: "multiple_choice", purpose: "p" }] };
    expect(LessonOutlineInput.safeParse(outline).success).toBe(false);
  });
});
