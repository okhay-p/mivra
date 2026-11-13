import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ArtifactView,
  CompositionArtifactView,
  CompositionSpec,
  LessonSectionKind,
  artifactKinds,
  compositionArtifactKind,
  compositionChanges,
  kindForTool,
  resolveCompositionStep,
} from "../src/index.js";
import { aliasingComposition, eventLoopComposition, pipelineComposition } from "./composition-fixtures.js";

const fixtures = { aliasingComposition, pipelineComposition, eventLoopComposition };

/** The smallest valid composition: one group holding one entity, in one step. */
const step = { explanation: "x", placements: [{ groupId: "g", entityIds: ["e"] }], hidden: [] as string[], connections: [] as string[] };
const base = {
  title: "t",
  groups: [{ id: "g", label: "G", ordered: false }],
  entities: [{ id: "e", label: "E", properties: [] as { name: string; value: string | number | boolean }[] }],
  connections: [] as { id: string; from: string; to: string; label?: string }[],
  steps: [step],
};
/** Two entities joined by connection c, both placed. */
const pair = {
  ...base,
  entities: [...base.entities, { id: "f", label: "F", properties: [] }],
  connections: [{ id: "c", from: "e", to: "f" }],
  steps: [{ ...step, placements: [{ groupId: "g", entityIds: ["e", "f"] }], connections: ["c"] }],
};

const ok = (spec: unknown) => CompositionSpec.safeParse(spec).success;
const issues = (spec: unknown) => CompositionSpec.safeParse(spec).error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n") ?? "";
const withEntity = (entity: object, spec: typeof base = base) => ({ ...spec, entities: [{ ...spec.entities[0], ...entity }, ...spec.entities.slice(1)] });
const withBody = (...body: object[]) => withEntity({ body });
const withStep = (extra: object, spec: typeof base = pair) => ({ ...spec, steps: [{ ...spec.steps[0], ...extra }] });
const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
const props = (n: number) => many(n, (i) => ({ name: `p${i}`, value: i }));

describe("composition spec", () => {
  it.each(Object.entries(fixtures))("accepts %s unchanged, as stored spec and as tool input", (_name, fixture) => {
    expect(CompositionSpec.parse(fixture)).toEqual(fixture);
    expect(compositionArtifactKind.input.parse(fixture)).toEqual(fixture);
  });

  it("accepts the smallest composition, and one whose step hides everything", () => {
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, steps: [{ ...step, placements: [{ groupId: "g", entityIds: [] }], hidden: ["e"] }] })).toBe(true);
  });

  it("gives tool adapters a JSON schema for the input", () => {
    const schema = z.toJSONSchema(compositionArtifactKind.input, { io: "input" }) as { required?: string[]; additionalProperties?: unknown };
    expect(schema.required).toEqual(["title", "groups", "entities", "connections", "steps"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("rejects {} at every level, missing required parts and unknown fields", () => {
    expect(ok({})).toBe(false);
    expect(compositionArtifactKind.input.safeParse({}).success).toBe(false);
    for (const key of ["title", "groups", "entities", "connections", "steps"] as const) {
      const { [key]: _omitted, ...rest } = base;
      expect(ok(rest), key).toBe(false);
    }
    expect(ok({ ...base, groups: [{}] })).toBe(false);
    expect(ok({ ...base, groups: [{ id: "g", label: "G" }] })).toBe(false);
    expect(ok({ ...base, entities: [{}] })).toBe(false);
    expect(ok({ ...base, entities: [{ id: "e", label: "E" }] })).toBe(false);
    expect(ok({ ...base, steps: [{}] })).toBe(false);
    for (const key of ["explanation", "placements", "hidden", "connections"] as const) {
      const { [key]: _omitted, ...rest } = step;
      expect(ok({ ...base, steps: [rest] }), key).toBe(false);
    }
    expect(ok({ ...base, style: "color: red" })).toBe(false);
    expect(ok({ ...base, groups: [{ ...base.groups[0], x: 10 }] })).toBe(false);
    expect(ok(withEntity({ html: "<b>" }))).toBe(false);
    expect(ok(withEntity({ properties: [{ name: "n", value: 1, unit: "px" }] }))).toBe(false);
    expect(ok(withBody({ type: "text", text: "x", markdown: true }))).toBe(false);
    expect(ok(withBody({ type: "html", html: "<b>" }))).toBe(false);
    expect(ok({ ...pair, connections: [{ ...pair.connections[0], curve: 1 }] })).toBe(false);
    expect(ok(withStep({ layout: "row" }))).toBe(false);
    expect(ok(withStep({ placements: [{ groupId: "g", entityIds: ["e", "f"], columns: 2 }] }))).toBe(false);
    expect(ok(withStep({ state: [{ entityId: "e", properties: [], merge: true }] }))).toBe(false);
    expect(ok(withStep({ emphasis: [{ entityId: "e", tone: "active", color: "red" }] }))).toBe(false);
    expect(ok(withStep({ callouts: [{ entityId: "e", text: "x", position: "top" }] }))).toBe(false);
  });

  it("bounds the title, groups, entities, connections and steps", () => {
    expect(ok({ ...base, title: " " })).toBe(false);
    expect(ok({ ...base, title: "t".repeat(120) })).toBe(true);
    expect(ok({ ...base, title: "t".repeat(121) })).toBe(false);

    const groups = (n: number) => ({
      ...base,
      groups: many(n, (i) => ({ id: `g${i}`, label: "G", ordered: false })),
      steps: [{ ...step, placements: many(n, (i) => ({ groupId: `g${i}`, entityIds: i === 0 ? ["e"] : [] })) }],
    });
    expect(ok({ ...base, groups: [] })).toBe(false);
    expect(ok(groups(4))).toBe(true);
    expect(ok(groups(5))).toBe(false);

    const entities = (n: number) => ({
      ...base,
      entities: many(n, (i) => ({ id: `e${i}`, label: "E", properties: [] })),
      steps: [{ ...step, placements: [{ groupId: "g", entityIds: many(n, (i) => `e${i}`) }] }],
    });
    expect(ok({ ...base, entities: [] })).toBe(false);
    expect(ok(entities(16))).toBe(true);
    expect(ok(entities(17))).toBe(false);

    const connections = (n: number) => ({ ...pair, connections: many(n, (i) => ({ id: `c${i}`, from: "e", to: "f" })), steps: [{ ...pair.steps[0]!, connections: many(n, (i) => `c${i}`) }] });
    expect(ok(connections(24))).toBe(true);
    expect(ok(connections(25))).toBe(false);

    expect(ok({ ...base, steps: [] })).toBe(false);
    expect(ok({ ...base, steps: Array(20).fill(step) })).toBe(true);
    expect(ok({ ...base, steps: Array(21).fill(step) })).toBe(false);
  });

  it("bounds ids and labels, trimming both", () => {
    const withId = (id: string) => ({ ...base, entities: [{ id, label: "E", properties: [] }], steps: [{ ...step, placements: [{ groupId: "g", entityIds: [id] }] }] });
    expect(ok(withId("i".repeat(24)))).toBe(true);
    expect(ok(withId("i".repeat(25)))).toBe(false);
    expect(ok(withId(" "))).toBe(false);
    expect(CompositionSpec.parse(withEntity({ id: " e ", label: "  E  " })).entities[0]).toMatchObject({ id: "e", label: "E" });

    for (const label of ["", " ", "l".repeat(33)]) {
      expect(ok(withEntity({ label }))).toBe(false);
      expect(ok({ ...base, groups: [{ ...base.groups[0], label }] })).toBe(false);
      expect(ok({ ...pair, connections: [{ ...pair.connections[0], label }] })).toBe(false);
    }
    expect(ok(withEntity({ label: "l".repeat(32) }))).toBe(true);
    expect(ok({ ...base, groups: [{ ...base.groups[0], label: "l".repeat(32) }] })).toBe(true);
    expect(ok({ ...pair, connections: [{ ...pair.connections[0], label: "l".repeat(32) }] })).toBe(true);
  });

  it("bounds properties: 0-6 unique names, each a finite number, a boolean or literal text", () => {
    expect(ok(withEntity({ properties: props(6) }))).toBe(true);
    expect(ok(withEntity({ properties: props(7) }))).toBe(false);
    const value = (v: unknown) => ok(withEntity({ properties: [{ name: "n", value: v }] }));
    expect([1.5, -0, true, false, "", "  kept  ", "v".repeat(64)].map(value)).toEqual(Array(7).fill(true));
    expect([Infinity, -Infinity, NaN, null, undefined, {}, [], [1], "v".repeat(65)].map(value)).toEqual(Array(9).fill(false));
    expect(CompositionSpec.parse(withEntity({ properties: [{ name: "n", value: "  kept  " }] })).entities[0]!.properties[0]!.value).toBe("  kept  ");
    for (const name of ["", " ", "n".repeat(33)]) expect(ok(withEntity({ properties: [{ name, value: 1 }] }))).toBe(false);
    expect(issues(withEntity({ properties: [{ name: "n", value: 1 }, { name: "n", value: 2 }] }))).toMatch(/entities\.0\.properties\.1\.name: property "n" appears twice/);
    expect(issues(withStep({ state: [{ entityId: "e", properties: [{ name: "n", value: 1 }, { name: " n ", value: 2 }] }] }))).toMatch(/steps\.0\.state\.0\.properties\.1\.name: property "n" appears twice/);
    expect(ok(withStep({ state: [{ entityId: "e", properties: props(6) }] }))).toBe(true);
    expect(ok(withStep({ state: [{ entityId: "e", properties: props(7) }] }))).toBe(false);
  });

  it("bounds body blocks", () => {
    const text = { type: "text", text: "x" };
    expect(ok(withBody())).toBe(true);
    expect(ok(withBody(text, text))).toBe(true);
    expect(ok(withBody(text, text, text))).toBe(false);

    expect(ok(withBody({ type: "text", text: " " }))).toBe(false);
    expect(ok(withBody({ type: "text", text: "x".repeat(280) }))).toBe(true);
    expect(ok(withBody({ type: "text", text: "x".repeat(281) }))).toBe(false);

    expect(ok(withBody({ type: "math", source: " " }))).toBe(false);
    expect(ok(withBody({ type: "math", source: "x".repeat(300) }))).toBe(true);
    expect(ok(withBody({ type: "math", source: "x".repeat(301) }))).toBe(false);
    // A malformed formula is still stored: the renderer falls back to showing its source.
    expect(ok(withBody({ type: "math", source: "\\frac{1}{" }))).toBe(true);

    const code = (source: string, language = "Python") => withBody({ type: "code", language, code: source });
    expect(ok(code(""))).toBe(false);
    expect(issues(code(" \n\t\n"))).toMatch(/entities\.0\.body\.0\.code: code has no code/);
    expect(ok(code("x", ""))).toBe(false);
    expect(ok(code("x", "l".repeat(33)))).toBe(false);
    // Any language is accepted: one without highlighting renders as plain monospace text.
    expect(ok(code("x", "Brainfuck++ (dialect)"))).toBe(true);
    expect(ok(code(Array(12).fill("x").join("\n")))).toBe(true);
    expect(ok(code(`${Array(12).fill("x").join("\n")}\n`))).toBe(true);
    expect(issues(code(Array(13).fill("x").join("\n")))).toMatch(/code has 13 lines; at most 12/);
    expect(ok(code("x".repeat(80)))).toBe(true);
    expect(issues(code(`ok\n${"x".repeat(81)}`))).toMatch(/line 2 is longer than 80 characters/);
  });

  it("normalises line endings in code before counting, and keeps its indentation", () => {
    const parsed = CompositionSpec.parse(withBody({ type: "code", language: "Python", code: "  if x:\r\n\treturn 1  \r\n" }));
    expect(parsed.entities[0]!.body).toEqual([{ type: "code", language: "Python", code: "  if x:\n\treturn 1  \n" }]);
    // 12 CRLF lines of 80 characters fit; counted raw, the line endings would push them over.
    expect(ok(withBody({ type: "code", language: "Python", code: Array(12).fill("x".repeat(80)).join("\r\n") }))).toBe(true);
  });

  it("caps body content at 1,000 characters per entity and 4,000 per artifact", () => {
    // 8 lines of 80 plus 8 newlines plus 72 = 720 characters of code; with 280 of text, exactly 1,000.
    const code = (last: number) => ({ type: "code", language: "a language name is not counted", code: `${Array(8).fill("x".repeat(80)).join("\n")}\n${"x".repeat(last)}` });
    const text = { type: "text", text: "x".repeat(280) };
    expect(ok(withBody(text, code(72)))).toBe(true);
    expect(issues(withBody(text, code(73)))).toMatch(/entities\.0\.body: entity "e" has 1001 characters of body content; at most 1000/);

    const full = (n: number) => ({
      ...base,
      entities: many(n, (i) => ({ id: `e${i}`, label: "E", properties: [], body: [text, code(72)] })),
      steps: [{ ...step, placements: [{ groupId: "g", entityIds: many(n, (i) => `e${i}`) }] }],
    });
    expect(ok(full(4))).toBe(true);
    expect(issues(full(5))).toMatch(/entities: the bodies total 5000 characters; at most 4000/);
  });

  it("bounds a step's explanation, label and optional arrays", () => {
    expect(ok(withStep({ explanation: " " }))).toBe(false);
    expect(ok(withStep({ explanation: "e".repeat(500) }))).toBe(true);
    expect(ok(withStep({ explanation: "e".repeat(501) }))).toBe(false);
    expect(ok(withStep({ label: " " }))).toBe(false);
    expect(ok(withStep({ label: "l".repeat(80) }))).toBe(true);
    expect(ok(withStep({ label: "l".repeat(81) }))).toBe(false);
    expect(ok(withStep({ emphasis: [{ entityId: "e", tone: "active" }, { entityId: "f", tone: "muted" }] }))).toBe(true);
    expect(ok(withStep({ emphasis: [{ entityId: "e", tone: "neutral" }] }))).toBe(false);
    expect(ok(withStep({ emphasis: [{ entityId: "e" }] }))).toBe(false);
    expect(ok(withStep({ callouts: [{ entityId: "e", text: "c".repeat(140) }, { entityId: "f", text: "c" }] }))).toBe(true);
    expect(ok(withStep({ callouts: [{ entityId: "e", text: "c".repeat(141) }] }))).toBe(false);
    expect(ok(withStep({ callouts: [{ entityId: "e", text: " " }] }))).toBe(false);

    const three = { ...pair, entities: [...pair.entities, { id: "h", label: "H", properties: [] }] };
    const placements = [{ groupId: "g", entityIds: ["e", "f", "h"] }];
    expect(ok(withStep({ placements, callouts: [{ entityId: "e", text: "c" }, { entityId: "f", text: "c" }] }, three))).toBe(true);
    expect(ok(withStep({ placements, callouts: ["e", "f", "h"].map((entityId) => ({ entityId, text: "c" })) }, three))).toBe(false);
    // The array caps hold on their own, before any relational check.
    expect(ok(withStep({ hidden: Array(17).fill("e") }))).toBe(false);
    expect(ok(withStep({ connections: Array(25).fill("c") }))).toBe(false);
    expect(ok(withStep({ placements: [{ groupId: "g", entityIds: Array(17).fill("e") }] }))).toBe(false);
    expect(ok(withStep({ state: Array(17).fill({ entityId: "e", properties: [] }) }))).toBe(false);
    expect(ok(withStep({ emphasis: Array(17).fill({ entityId: "e", tone: "done" }) }))).toBe(false);
  });
});

describe("composition relational checks", () => {
  it("needs one id per declaration, across groups, entities and connections", () => {
    expect(issues({ ...base, groups: [base.groups[0], base.groups[0]] })).toMatch(/groups\.1\.id: id "g" is already used by a group/);
    expect(issues(withEntity({ id: "g" }))).toMatch(/entities\.0\.id: id "g" is already used by a group/);
    expect(issues({ ...pair, entities: [pair.entities[0], { ...pair.entities[1], id: " e " }] })).toMatch(/entities\.1\.id: id "e" is already used by a entity/);
    expect(issues({ ...pair, connections: [{ id: "e", from: "e", to: "f" }] })).toMatch(/connections\.0\.id: id "e" is already used by a entity/);
    expect(issues({ ...pair, connections: [pair.connections[0], pair.connections[0]] })).toMatch(/connections\.1\.id: id "c" is already used by a connection/);
  });

  it("joins two different declared entities, and allows parallel connections with their own ids", () => {
    expect(issues({ ...pair, connections: [{ id: "c", from: "e", to: "nope" }] })).toMatch(/connections\.0\.to: no entity has id "nope"/);
    expect(issues({ ...pair, connections: [{ id: "c", from: "g", to: "f" }] })).toMatch(/connections\.0\.from: no entity has id "g"/);
    expect(issues({ ...pair, connections: [{ id: "c", from: "e", to: "e" }] })).toMatch(/connection "c" joins "e" to itself/);
    const parallel = { ...pair, connections: [{ id: "c", from: "e", to: "f", label: "first" }, { id: "d", from: "e", to: "f", label: "last" }, { id: "back", from: "f", to: "e" }] };
    expect(ok(parallel)).toBe(true);
  });

  it("needs exactly one placement for every group, in any order", () => {
    const two = { ...base, groups: [...base.groups, { id: "h", label: "H", ordered: true }] };
    expect(issues(two)).toMatch(/steps\.0\.placements: step 1 has no placement for group "h": add \{ groupId: "h", entityIds: \[\] \}/);
    expect(ok({ ...two, steps: [{ ...step, placements: [{ groupId: "h", entityIds: [] }, { groupId: "g", entityIds: ["e"] }] }] })).toBe(true);
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: ["e"] }, { groupId: "g", entityIds: ["f"] }] }))).toMatch(/steps\.0\.placements\.1\.groupId: group "g" has two placements in step 1/);
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: ["e", "f"] }, { groupId: "nope", entityIds: [] }] }))).toMatch(/steps\.0\.placements\.1\.groupId: no group has id "nope"/);
    expect(issues(withStep({ placements: [{ groupId: "e", entityIds: ["e", "f"] }] }))).toMatch(/no group has id "e"/);
  });

  it("accounts for every entity exactly once across placements and hidden", () => {
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: ["e"] }], connections: [] }))).toMatch(
      /steps\.0: entity "f" is not accounted for in step 1: list it in one placement's entityIds, or in hidden/,
    );
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: ["e", "f", "e"] }] }))).toMatch(/steps\.0\.placements\.0\.entityIds\.2: entity "e" is already in group "g" in step 1/);
    expect(issues(withStep({ hidden: ["f"], connections: [] }))).toMatch(/steps\.0\.hidden\.0: entity "f" is already in group "g" in step 1/);
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: [] }], hidden: ["e", "f", "e"], connections: [] }))).toMatch(/steps\.0\.hidden\.2: entity "e" is already hidden in step 1/);
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: ["e", "f", "nope"] }] }))).toMatch(/steps\.0\.placements\.0\.entityIds\.2: no entity has id "nope"/);
    expect(issues(withStep({ hidden: ["c"] }))).toMatch(/steps\.0\.hidden\.0: no entity has id "c"/);
    // Across two groups too, and the step number is the one at fault.
    const two = { ...pair, groups: [...pair.groups, { id: "h", label: "H", ordered: false }] };
    const good = { ...pair.steps[0]!, placements: [{ groupId: "g", entityIds: ["e", "f"] }, { groupId: "h", entityIds: [] }] };
    const bad = { ...good, placements: [{ groupId: "g", entityIds: ["e", "f"] }, { groupId: "h", entityIds: ["f"] }] };
    expect(issues({ ...two, steps: [good, bad] })).toMatch(/steps\.1\.placements\.1\.entityIds\.0: entity "f" is already in group "g" in step 2/);
  });

  it("shows only declared connections, once each, with both ends placed", () => {
    expect(issues(withStep({ connections: ["nope"] }))).toMatch(/steps\.0\.connections\.0: no connection has id "nope"/);
    expect(issues(withStep({ connections: ["e"] }))).toMatch(/no connection has id "e"/);
    expect(issues(withStep({ connections: ["c", "c"] }))).toMatch(/steps\.0\.connections\.1: connection "c" is listed twice in step 1/);
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: ["e"] }], hidden: ["f"] }))).toMatch(
      /steps\.0\.connections\.0: connection "c" needs entity "f", which is not placed in a group in step 1/,
    );
    // Visibility is never inferred from the ends: both placed, and still no connection.
    expect(ok(withStep({ connections: [] }))).toBe(true);
  });

  it.each(["state", "emphasis", "callouts"] as const)("targets each visible entity at most once in %s", (field) => {
    const entry = (entityId: string) => ({ entityId, ...(field === "state" ? { properties: [] } : field === "emphasis" ? { tone: "done" } : { text: "note" }) });
    expect(ok(withStep({ [field]: [entry("e"), entry("f")] }))).toBe(true);
    expect(ok(withStep({ [field]: [] }))).toBe(true);
    expect(issues(withStep({ [field]: [entry("nope")] }))).toMatch(new RegExp(`steps\\.0\\.${field}\\.0\\.entityId: no entity has id "nope"`));
    expect(issues(withStep({ [field]: [entry("g")] }))).toMatch(/no entity has id "g"/);
    expect(issues(withStep({ [field]: [entry("e"), entry("e")] }))).toMatch(new RegExp(`steps\\.0\\.${field}\\.1\\.entityId: entity "e" has two ${field} entries in step 1`));
    expect(issues(withStep({ placements: [{ groupId: "g", entityIds: ["e"] }], hidden: ["f"], connections: [], [field]: [entry("f")] }))).toMatch(
      new RegExp(`steps\\.0\\.${field}\\.0\\.entityId: entity "f" is not placed in a group in step 1`),
    );
  });
});

describe("composition authoring checks", () => {
  const latex = "the sum \\frac{1}{2}";
  const rejected = (spec: unknown) => !compositionArtifactKind.input.safeParse(spec).success;

  it("asks for dollar delimiters in the title, labels, text blocks, explanations and callouts", () => {
    expect(rejected({ ...base, title: latex })).toBe(true);
    expect(rejected({ ...base, groups: [{ ...base.groups[0], label: latex }] })).toBe(true);
    expect(rejected(withEntity({ label: latex }))).toBe(true);
    expect(rejected(withBody({ type: "text", text: latex }))).toBe(true);
    expect(rejected({ ...pair, connections: [{ ...pair.connections[0], label: latex }] })).toBe(true);
    expect(rejected(withStep({ explanation: latex }))).toBe(true);
    expect(rejected(withStep({ callouts: [{ entityId: "e", text: latex }] }))).toBe(true);
    expect(rejected({ ...base, title: "the sum $\\frac{1}{2}$" })).toBe(false);
  });

  it("leaves code, languages, ids, property strings, step labels and display formulas literal", () => {
    const literal = {
      ...base,
      entities: [
        {
          id: "\\alpha",
          label: "E",
          properties: [{ name: "\\path", value: "C:\\Users\\me" }],
          body: [{ type: "code", language: "\\LaTeX", code: "\\newcommand{\\x}{1}" }, { type: "math", source: "\\frac{1}{2}" }],
        },
      ],
      steps: [{ ...step, label: "print('\\tab\\newline')", placements: [{ groupId: "g", entityIds: ["\\alpha"] }], state: [{ entityId: "\\alpha", properties: [{ name: "\\dir", value: "\\root" }] }] }],
    };
    expect(compositionArtifactKind.input.parse(literal)).toEqual(literal);
  });

  it("keeps a stored spec readable when it would fail today's authoring checks", () => {
    const stored = { ...base, title: latex };
    expect(CompositionSpec.parse(stored)).toEqual(stored);
    expect(CompositionArtifactView.safeParse({ id: "a", createdAt: "2026-11-13T00:00:00.000Z", kind: "composition", version: 1, spec: stored }).success).toBe(true);
  });
});

describe("resolveCompositionStep", () => {
  it("shows every group in declaration order, whatever order the placements came in", () => {
    const last = resolveCompositionStep(pipelineComposition, 3);
    expect(last.groups.map((group) => group.id)).toEqual(["source", "lexer", "parser", "compiler"]);
    expect(last.groups.map((group) => group.entities.map((entity) => entity.id))).toEqual([["src"], ["tokens"], ["ast"], ["bytecode"]]);
    expect(last.label).toBe("compile");
    // Empty groups stay, and hidden entities are nowhere.
    const first = resolveCompositionStep(pipelineComposition, 0);
    expect(first.groups.map((group) => group.entities.length)).toEqual([1, 0, 0, 0]);
    expect(first.label).toBeUndefined();
    expect(first.connections).toEqual([]);
  });

  it("keeps placement order inside a group, with the first entity at the front", () => {
    expect(resolveCompositionStep(eventLoopComposition, 0).groups[0]!.entities.map((entity) => entity.id)).toEqual(["timer", "click", "fetch"]);
    expect(resolveCompositionStep(eventLoopComposition, 1).groups[0]!.entities.map((entity) => entity.id)).toEqual(["click", "timer", "fetch"]);
    expect(resolveCompositionStep(eventLoopComposition, 0).groups[0]!.ordered).toBe(true);
  });

  it("replaces an entity's whole property list for a step, adding and removing properties", () => {
    const spec = CompositionSpec.parse({
      ...base,
      entities: [{ id: "e", label: "E", properties: [{ name: "kept", value: 1 }, { name: "dropped", value: true }] }],
      steps: [step, { ...step, state: [{ entityId: "e", properties: [{ name: "added", value: "new" }, { name: "kept", value: 2 }] }] }, { ...step, state: [{ entityId: "e", properties: [] }] }],
    });
    const properties = (i: number) => resolveCompositionStep(spec, i).groups[0]!.entities[0]!.properties;
    expect(properties(0)).toEqual([{ name: "kept", value: 1 }, { name: "dropped", value: true }]);
    // Not a merge: "dropped" is gone because the replacement doesn't list it.
    expect(properties(1)).toEqual([{ name: "added", value: "new" }, { name: "kept", value: 2 }]);
    expect(properties(2)).toEqual([]);
  });

  it("goes back to the declared properties when a step has no state entry, never the previous step's", () => {
    const declared = aliasingComposition.entities[2]!.properties;
    const changed = [{ name: "items", value: "[1, 2, 3, 4]" }, { name: "length", value: 4 }];
    const list = (spec: CompositionSpec, i: number) => resolveCompositionStep(spec, i).groups[1]!.entities[0]!.properties;
    expect(list(aliasingComposition, 2)).toEqual(changed);
    expect(list(aliasingComposition, 3)).toEqual(changed);
    // Drop the last step's state entry: the list shows its declaration again, though step 3 changed it.
    const { state: _state, ...lastStep } = aliasingComposition.steps[3]!;
    const reset = CompositionSpec.parse({ ...aliasingComposition, steps: [...aliasingComposition.steps.slice(0, 3), lastStep] });
    expect(list(reset, 2)).toEqual(changed);
    expect(list(reset, 3)).toEqual(declared);
  });

  it("drops emphasis and callouts that a step doesn't repeat", () => {
    const list = (i: number) => resolveCompositionStep(aliasingComposition, i).groups[1]!.entities[0]!;
    expect(list(2)).toMatchObject({ tone: "active", callout: "Changed in place: still the same object." });
    expect(list(3).tone).toBeUndefined();
    expect(list(3).callout).toBeUndefined();
  });

  it("puts each visible connection on its source card as a reference", () => {
    const names = (i: number) => resolveCompositionStep(aliasingComposition, i).groups[0]!.entities.map((entity) => [entity.id, entity.references.map((reference) => reference.connectionId)]);
    expect(names(0)).toEqual([["a", ["a_list1"]]]);
    expect(names(1)).toEqual([["a", ["a_list1"]], ["b", ["b_list1"]]]);
    expect(names(3)).toEqual([["a", ["a_list1"]], ["b", ["b_list2"]]]);
    expect(resolveCompositionStep(aliasingComposition, 3).connections.map((connection) => connection.id)).toEqual(["a_list1", "b_list2"]);
    expect(resolveCompositionStep(pipelineComposition, 1).groups[1]!.entities[0]!.references).toEqual([{ connectionId: "lexed", to: "src", toLabel: "program", label: "read from" }]);
    // Parallel connections stay apart, in declaration order whatever order the step listed them in.
    const parallel = CompositionSpec.parse({
      ...pair,
      connections: [{ id: "c", from: "e", to: "f", label: "first" }, { id: "d", from: "e", to: "f", label: "last" }],
      steps: [{ ...pair.steps[0]!, connections: ["d", "c"] }],
    });
    expect(resolveCompositionStep(parallel, 0).groups[0]!.entities[0]!.references.map((reference) => reference.label)).toEqual(["first", "last"]);
  });

  it("carries the fixed body on every step the entity is shown", () => {
    const body = pipelineComposition.entities[0]!.body;
    for (const i of [0, 1, 2, 3]) expect(resolveCompositionStep(pipelineComposition, i).groups[0]!.entities[0]!.body).toEqual(body);
    expect(resolveCompositionStep(eventLoopComposition, 0).groups[0]!.entities[0]!.body).toEqual([]);
  });

  it("resolves a step that hides everything", () => {
    const spec = CompositionSpec.parse({ ...pair, steps: [pair.steps[0], { ...step, placements: [{ groupId: "g", entityIds: [] }], hidden: ["f", "e"] }] });
    const empty = resolveCompositionStep(spec, 1);
    expect(empty.groups).toEqual([{ id: "g", label: "G", ordered: false, entities: [] }]);
    expect(empty.connections).toEqual([]);
  });

  it.each(Object.entries(fixtures))("gives the same snapshot for %s by seek, back and reset as by stepping forward", (_name, fixture) => {
    const spec = deepFreeze(CompositionSpec.parse(fixture));
    const forward = spec.steps.map((_step, i) => resolveCompositionStep(spec, i));
    const last = spec.steps.length - 1;
    const visits = [last, 0, last, ...forward.map((_s, i) => last - i), 0, 2, 1, 2, 0];
    for (const i of visits) expect(resolveCompositionStep(spec, i)).toEqual(forward[i]);
    expect(forward.map((resolved) => resolved.index)).toEqual(spec.steps.map((_step, i) => i));
  });

  it("clamps an index outside the steps", () => {
    expect(resolveCompositionStep(aliasingComposition, -1).index).toBe(0);
    expect(resolveCompositionStep(aliasingComposition, 99).index).toBe(3);
    expect(resolveCompositionStep(aliasingComposition, NaN).index).toBe(0);
    expect(resolveCompositionStep(aliasingComposition, 1.7).index).toBe(1);
  });

  it("treats ids as data, not as object keys", () => {
    const spec = CompositionSpec.parse({
      ...base,
      entities: [{ id: "__proto__", label: "Proto", properties: [] }, { id: "constructor", label: "Ctor", properties: [] }],
      connections: [{ id: "toString", from: "__proto__", to: "constructor" }],
      steps: [{ ...step, placements: [{ groupId: "g", entityIds: ["constructor", "__proto__"] }], connections: ["toString"], emphasis: [{ entityId: "__proto__", tone: "done" }] }],
    });
    const entities = resolveCompositionStep(spec, 0).groups[0]!.entities;
    expect(entities.map((entity) => [entity.id, entity.tone])).toEqual([["constructor", undefined], ["__proto__", "done"]]);
    expect(entities[1]!.references).toEqual([{ connectionId: "toString", to: "constructor", toLabel: "Ctor", label: undefined }]);
    expect(compositionChanges(spec, 0).map((change) => change.text)).toEqual(["G holds Ctor, Proto.", "Proto → Ctor is connected."]);
  });
});

describe("compositionChanges", () => {
  const texts = (spec: CompositionSpec, i: number) => compositionChanges(spec, i).map((change) => change.text);

  it("describes the initial state on the first step", () => {
    expect(compositionChanges(aliasingComposition, 0)).toEqual([
      { type: "initial", text: "Names holds a." },
      { type: "initial", text: "Objects holds list." },
      { type: "initial", text: "a → list is connected." },
    ]);
    expect(texts(eventLoopComposition, 0)).toEqual(["Task queue holds onTimeout, onClick, onResponse.", "Call stack is empty."]);
  });

  it("reports appearing entities, changed properties and connections added and removed", () => {
    expect(compositionChanges(aliasingComposition, 1)).toEqual([
      { type: "appeared", entityId: "b", groupId: "names", text: "b appears in Names." },
      { type: "connection_added", connectionId: "b_list1", text: "b → list is connected." },
    ]);
    expect(compositionChanges(aliasingComposition, 2)).toEqual([
      { type: "property_changed", entityId: "list1", name: "items", text: "list: items changes from [1, 2, 3] to [1, 2, 3, 4]." },
      { type: "property_changed", entityId: "list1", name: "length", text: "list: length changes from 3 to 4." },
    ]);
    // Rebinding: both lists are visible, and only the connections say which one b refers to.
    expect(compositionChanges(aliasingComposition, 3)).toEqual([
      { type: "appeared", entityId: "list2", groupId: "heap", text: "new list appears in Objects." },
      { type: "connection_removed", connectionId: "b_list1", text: "b → list is disconnected." },
      { type: "connection_added", connectionId: "b_list2", text: "b → new list is connected." },
    ]);
    expect(texts(pipelineComposition, 1)).toEqual(["token stream appears in Tokens.", "token stream → program (read from) is connected."]);
  });

  it("reports a reorder within a group, a move between groups and an entity going out of sight", () => {
    expect(compositionChanges(eventLoopComposition, 1)).toEqual([
      { type: "reordered", groupId: "queue", text: "Task queue is reordered: onClick, onTimeout, onResponse." },
      { type: "property_changed", entityId: "click", name: "priority", text: "onClick: priority changes from normal to user input." },
    ]);
    // Leaving the queue is a move, not a reorder of what stays behind; the property is back to its declaration.
    expect(compositionChanges(eventLoopComposition, 2)).toEqual([
      { type: "moved", entityId: "click", fromGroupId: "queue", toGroupId: "stack", text: "onClick moves from Task queue to Call stack." },
      { type: "property_changed", entityId: "click", name: "priority", text: "onClick: priority changes from user input to normal." },
    ]);
    expect(compositionChanges(eventLoopComposition, 3)).toEqual([{ type: "hidden", entityId: "click", groupId: "stack", text: "onClick leaves Call stack." }]);
  });

  it("reports properties added and removed, and nothing when a step changes nothing visible", () => {
    const spec = CompositionSpec.parse({
      ...base,
      entities: [{ id: "e", label: "E", properties: [{ name: "a", value: 1 }, { name: "b", value: "" }] }],
      steps: [
        step,
        { ...step, state: [{ entityId: "e", properties: [{ name: "b", value: "$5" }, { name: "c", value: false }] }] },
        { ...step, explanation: "Only the emphasis differs.", emphasis: [{ entityId: "e", tone: "done" }], state: [{ entityId: "e", properties: [{ name: "c", value: false }, { name: "b", value: "$5" }] }] },
      ],
    });
    expect(compositionChanges(spec, 1)).toEqual([
      // Literal dollars are escaped, so a property value never renders as a formula.
      { type: "property_changed", entityId: "e", name: "b", text: 'E: b changes from "" to \\$5.' },
      { type: "property_added", entityId: "e", name: "c", text: "E gains c = false." },
      { type: "property_removed", entityId: "e", name: "a", text: "E loses a." },
    ]);
    expect(compositionChanges(spec, 2)).toEqual([]);
  });

  it("compares with the declared step before, whichever way the learner got here", () => {
    const spec = deepFreeze(CompositionSpec.parse(eventLoopComposition));
    const forward = spec.steps.map((_step, i) => compositionChanges(spec, i));
    for (const i of [3, 1, 0, 2, 3, 0]) expect(compositionChanges(spec, i)).toEqual(forward[i]);
  });
});

describe("composition rollout", () => {
  const view = { id: "a", createdAt: "2026-11-13T00:00:00.000Z", kind: "composition", version: 1, spec: aliasingComposition };

  it("describes show_composition v1 and its strict view", () => {
    expect(compositionArtifactKind.toolName).toBe("show_composition");
    expect(compositionArtifactKind.version).toBe(1);
    expect(compositionArtifactKind.description).toMatch(/show_graph instead for topology/);
    expect(CompositionArtifactView.parse(view)).toEqual(view);
    expect(CompositionArtifactView.safeParse({ ...view, version: 2 }).success).toBe(false);
    expect(CompositionArtifactView.safeParse({ ...view, latestAttempt: {} }).success).toBe(false);
    expect(CompositionArtifactView.safeParse({ ...view, spec: {} }).success).toBe(false);
    expect(CompositionArtifactView.safeParse({ ...view, spec: { ...aliasingComposition, secret: 1 } }).success).toBe(false);
  });

  // Flip these when #113 adds the renderer: see the activation steps on compositionArtifactKind.
  it("stays dormant: not a registered kind, a lesson section kind or a client view yet", () => {
    expect(Object.keys(artifactKinds)).not.toContain("composition");
    expect(kindForTool("show_composition")).toBeUndefined();
    expect(LessonSectionKind.safeParse("composition").success).toBe(false);
    expect(ArtifactView.safeParse(view).success).toBe(false);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
