import { z } from "zod";
import { codeLines } from "./algorithm-trace.js";
import { artifactMathInput } from "./artifact-math-input.js";

/**
 * composition v1 (#109): entities located in containers, the references they share and how they move.
 * Covers aliasing, pipelines and queues. Graph stays the kind for topology; composition says where things
 * are. The model never gives coordinates, styles or layout hints, and code is inert text.
 *
 * State rules (renderers must follow them, through `resolveCompositionStep`):
 * - Every step is a complete snapshot, resolved from the declarations alone. Nothing carries over from the
 *   step before, so back, direct seek and reset show exactly what stepping forward showed.
 * - `placements` and `hidden` account for every entity exactly once. `connections` lists every connection
 *   visible in the step; one is never shown merely because both of its ends are.
 * - `state` replaces an entity's whole property list for that step. Without an entry the entity shows its
 *   declared properties, never the previous step's.
 * - An entity's `body` is fixed across steps.
 *
 * Staged rollout: this file is the whole protocol contract, but the kind is not in `artifactKinds`,
 * `ArtifactView` or `LessonSectionKind` yet, so the model can't produce it before a renderer exists.
 * `compositionArtifactKind` lists the activation points for #113.
 */

export const MAX_COMPOSITION_GROUPS = 4;
export const MAX_COMPOSITION_ENTITIES = 16;
export const MAX_COMPOSITION_CONNECTIONS = 24;
export const MAX_COMPOSITION_STEPS = 20;
export const MAX_COMPOSITION_PROPERTIES = 6;
export const MAX_COMPOSITION_BLOCKS = 2;
export const MAX_COMPOSITION_CALLOUTS = 2;
export const MAX_COMPOSITION_CODE_LINES = 12;
export const MAX_COMPOSITION_CODE_LINE_LENGTH = 80;
export const MAX_COMPOSITION_ENTITY_BODY = 1000;
export const MAX_COMPOSITION_BODY = 4000;

const Id = z.string().trim().min(1).max(24);
const Label = z.string().trim().min(1).max(32);

export const CompositionTone = z.enum(["active", "done", "muted"]);
export type CompositionTone = z.infer<typeof CompositionTone>;

export const CompositionProperty = z
  .object({
    name: Label.describe("Literal property name, unique within its list. Not a formula."),
    value: z
      .union([z.number(), z.boolean(), z.string().max(64)])
      .describe('A number, a boolean or literal text of at most 64 characters ("" is allowed). Never Markdown or a formula; write a list or object as short text.'),
  })
  .strict();
export type CompositionProperty = z.infer<typeof CompositionProperty>;

const Properties = z.array(CompositionProperty).max(MAX_COMPOSITION_PROPERTIES);

export const CompositionBlock = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().trim().min(1).max(280).describe("A short note. Only $...$ is a formula; no Markdown."),
    })
    .strict(),
  z
    .object({
      type: z.literal("code"),
      language: Label.describe('The language, e.g. "Python" or "bytecode". Shown as a label; any language is accepted.'),
      code: z
        .string()
        .overwrite((code) => code.replace(/\r\n?/g, "\n"))
        .min(1)
        .max(MAX_COMPOSITION_CODE_LINES * (MAX_COMPOSITION_CODE_LINE_LENGTH + 1))
        .describe(
          `Plain text with newlines and its real indentation: at most ${MAX_COMPOSITION_CODE_LINES} lines of at most ${MAX_COMPOSITION_CODE_LINE_LENGTH} characters. No Markdown fences. Never run.`,
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("math"),
      source: z.string().trim().min(1).max(300).describe("One display formula as LaTeX, without dollar delimiters."),
    })
    .strict(),
]);
export type CompositionBlock = z.infer<typeof CompositionBlock>;

export const CompositionGroup = z
  .object({
    id: Id.describe("Unique id, used by each step's placements."),
    label: Label.describe("The container's name. Only $...$ is a formula."),
    ordered: z.boolean().describe("True when position matters, as in a queue or stack: the first entity is then the front or top. Say which it is in the step's explanation."),
  })
  .strict();
export type CompositionGroup = z.infer<typeof CompositionGroup>;

export const CompositionEntity = z
  .object({
    id: Id.describe("Unique id, used by connections and steps."),
    label: Label.describe("Short name on the card. Only $...$ is a formula."),
    properties: Properties.describe("The entity's declared properties, in display order; [] for none. A step shows these unless its `state` replaces them."),
    body: z
      .array(CompositionBlock)
      .max(MAX_COMPOSITION_BLOCKS)
      .optional()
      .describe(
        `Up to ${MAX_COMPOSITION_BLOCKS} blocks of text, code or maths inside the card, the same on every step. Their text, code and source may total ${MAX_COMPOSITION_ENTITY_BODY} characters per entity and ${MAX_COMPOSITION_BODY} over all entities.`,
      ),
  })
  .strict();
export type CompositionEntity = z.infer<typeof CompositionEntity>;

export const CompositionConnection = z
  .object({
    id: Id.describe("Unique id, listed by each step that shows this connection."),
    from: Id.describe("Id of the entity that holds the reference."),
    to: Id.describe("Id of the entity it refers to. Must differ from `from`."),
    label: Label.optional().describe('Optional name of the reference, e.g. "next". Only $...$ is a formula.'),
  })
  .strict();
export type CompositionConnection = z.infer<typeof CompositionConnection>;

export const CompositionStep = z
  .object({
    label: z.string().trim().min(1).max(80).optional().describe("Optional literal text for the step, shown in monospace, e.g. the statement `b = a`."),
    explanation: z.string().trim().min(1).max(500).describe("What this step shows and what changed, in one or two sentences."),
    placements: z
      .array(
        z
          .object({
            groupId: Id,
            entityIds: z.array(Id).max(MAX_COMPOSITION_ENTITIES).describe("The entities in this group at this step, top to bottom; [] for an empty group."),
          })
          .strict(),
      )
      .max(MAX_COMPOSITION_GROUPS)
      .describe("Exactly one entry for every group, at every step. Not carried over from earlier steps."),
    hidden: z
      .array(Id)
      .max(MAX_COMPOSITION_ENTITIES)
      .describe("Every entity not shown at this step, e.g. before it is created. Each entity is in exactly one placement or here."),
    connections: z
      .array(Id)
      .max(MAX_COMPOSITION_CONNECTIONS)
      .describe("Ids of the connections shown at this step; [] for none. Not carried over, and both ends must be placed in a group."),
    state: z
      .array(z.object({ entityId: Id, properties: Properties.describe("The entity's whole property list at this step; [] shows none.") }).strict())
      .max(MAX_COMPOSITION_ENTITIES)
      .optional()
      .describe("Entities whose properties differ from their declaration at this step, at most one entry each. Not carried over: an entity without an entry shows its declared properties again."),
    emphasis: z
      .array(
        z
          .object({ entityId: Id, tone: CompositionTone.describe("active = current focus, done = finished, muted = ruled out or idle.") })
          .strict(),
      )
      .max(MAX_COMPOSITION_ENTITIES)
      .optional()
      .describe("Entities to emphasise at this step, at most one entry each. Not carried over."),
    callouts: z
      .array(z.object({ entityId: Id, text: z.string().trim().min(1).max(140).describe("A short note shown inside the card. Only $...$ is a formula.") }).strict())
      .max(MAX_COMPOSITION_CALLOUTS)
      .optional()
      .describe("Notes on entities at this step, at most one per entity. Not carried over."),
  })
  .strict();
export type CompositionStep = z.infer<typeof CompositionStep>;

type Path = (string | number)[];

function checkProperties(properties: readonly CompositionProperty[], path: Path, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  properties.forEach((property, i) => {
    if (seen.has(property.name)) {
      ctx.addIssue({ code: "custom", path: [...path, i, "name"], message: `property "${property.name}" appears twice in this list: keep one, or rename the other` });
    }
    seen.add(property.name);
  });
}

/** How much a block counts toward the body totals. Newlines count; a code block's language doesn't. */
const blockLength = (block: CompositionBlock) => (block.type === "text" ? block.text : block.type === "code" ? block.code : block.source).length;

function checkStep(
  step: CompositionStep,
  i: number,
  declared: { groups: readonly CompositionGroup[]; entities: readonly CompositionEntity[]; connections: Map<string, CompositionConnection> },
  ctx: z.RefinementCtx,
) {
  const n = i + 1;
  const issue = (path: Path, message: string) => ctx.addIssue({ code: "custom", path: ["steps", i, ...path], message });
  const groupIds = new Set(declared.groups.map((group) => group.id));
  const entityIds = new Set(declared.entities.map((entity) => entity.id));

  const placedGroups = new Set<string>();
  const where = new Map<string, string>();
  const visible = new Set<string>();
  const account = (id: string, place: string, path: Path) => {
    if (!entityIds.has(id)) return issue(path, `no entity has id "${id}": use a declared entity id`);
    const earlier = where.get(id);
    if (earlier !== undefined) return issue(path, `entity "${id}" is already ${earlier} in step ${n}: list each entity exactly once per step`);
    where.set(id, place);
  };
  step.placements.forEach((placement, j) => {
    if (!groupIds.has(placement.groupId)) issue(["placements", j, "groupId"], `no group has id "${placement.groupId}": use a declared group id`);
    else if (placedGroups.has(placement.groupId)) issue(["placements", j, "groupId"], `group "${placement.groupId}" has two placements in step ${n}: merge them into one`);
    placedGroups.add(placement.groupId);
    placement.entityIds.forEach((id, k) => {
      account(id, `in group "${placement.groupId}"`, ["placements", j, "entityIds", k]);
      if (groupIds.has(placement.groupId) && entityIds.has(id)) visible.add(id);
    });
  });
  for (const group of declared.groups) {
    if (!placedGroups.has(group.id)) issue(["placements"], `step ${n} has no placement for group "${group.id}": add { groupId: "${group.id}", entityIds: [] } if it is empty`);
  }
  step.hidden.forEach((id, j) => {
    account(id, "hidden", ["hidden", j]);
    visible.delete(id);
  });
  for (const entity of declared.entities) {
    if (!where.has(entity.id)) issue([], `entity "${entity.id}" is not accounted for in step ${n}: list it in one placement's entityIds, or in hidden`);
  }

  const shown = new Set<string>();
  step.connections.forEach((id, j) => {
    const path = ["connections", j];
    const connection = declared.connections.get(id);
    if (!connection) return issue(path, `no connection has id "${id}": use a declared connection id`);
    if (shown.has(id)) issue(path, `connection "${id}" is listed twice in step ${n}: list it once`);
    shown.add(id);
    for (const end of [connection.from, connection.to]) {
      if (entityIds.has(end) && !visible.has(end)) {
        issue(path, `connection "${id}" needs entity "${end}", which is not placed in a group in step ${n}: place it, or leave the connection out of this step`);
      }
    }
  });

  const targets = (field: "state" | "emphasis" | "callouts") => {
    const seen = new Set<string>();
    step[field]?.forEach(({ entityId }, j) => {
      const path = [field, j, "entityId"];
      if (!entityIds.has(entityId)) return issue(path, `no entity has id "${entityId}": use a declared entity id`);
      if (seen.has(entityId)) issue(path, `entity "${entityId}" has two ${field} entries in step ${n}: merge them into one`);
      seen.add(entityId);
      if (!visible.has(entityId)) issue(path, `entity "${entityId}" is not placed in a group in step ${n}: place it, or remove this ${field} entry`);
    });
  };
  targets("state");
  targets("emphasis");
  targets("callouts");
  step.state?.forEach((entry, j) => checkProperties(entry.properties, ["steps", i, "state", j, "properties"], ctx));
}

export const CompositionSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    groups: z.array(CompositionGroup).min(1).max(MAX_COMPOSITION_GROUPS).describe("The containers, in reading order. Groups don't nest."),
    entities: z.array(CompositionEntity).min(1).max(MAX_COMPOSITION_ENTITIES).describe("Everything that is ever shown, declared once. Steps place or hide each one."),
    connections: z
      .array(CompositionConnection)
      .max(MAX_COMPOSITION_CONNECTIONS)
      .describe("Every directed reference that is ever shown; [] for none. Two entities may have several, each with its own id."),
    steps: z.array(CompositionStep).min(1).max(MAX_COMPOSITION_STEPS).describe("Complete snapshots in order. One step makes a static diagram."),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // Ids are data: they are only ever compared through Map and Set, never used as object keys or selectors.
    const usedBy = new Map<string, string>();
    const declare = (id: string, what: string, path: Path) => {
      const earlier = usedBy.get(id);
      if (earlier) ctx.addIssue({ code: "custom", path, message: `id "${id}" is already used by a ${earlier}: give every group, entity and connection its own id` });
      else usedBy.set(id, what);
    };
    spec.groups.forEach((group, i) => declare(group.id, "group", ["groups", i, "id"]));
    spec.entities.forEach((entity, i) => declare(entity.id, "entity", ["entities", i, "id"]));
    spec.connections.forEach((connection, i) => declare(connection.id, "connection", ["connections", i, "id"]));

    let bodyTotal = 0;
    spec.entities.forEach((entity, i) => {
      checkProperties(entity.properties, ["entities", i, "properties"], ctx);
      let entityTotal = 0;
      entity.body?.forEach((block, j) => {
        entityTotal += blockLength(block);
        if (block.type !== "code") return;
        const path = ["entities", i, "body", j, "code"];
        const lines = codeLines(block.code);
        if (lines.every((line) => line.trim() === "")) ctx.addIssue({ code: "custom", path, message: "code has no code: write some, or remove the block" });
        if (lines.length > MAX_COMPOSITION_CODE_LINES) {
          ctx.addIssue({ code: "custom", path, message: `code has ${lines.length} lines; at most ${MAX_COMPOSITION_CODE_LINES} are allowed: shorten it` });
        }
        const long = lines.findIndex((line) => line.length > MAX_COMPOSITION_CODE_LINE_LENGTH);
        if (long >= 0) ctx.addIssue({ code: "custom", path, message: `line ${long + 1} is longer than ${MAX_COMPOSITION_CODE_LINE_LENGTH} characters: break or shorten it` });
      });
      bodyTotal += entityTotal;
      if (entityTotal > MAX_COMPOSITION_ENTITY_BODY) {
        ctx.addIssue({
          code: "custom",
          path: ["entities", i, "body"],
          message: `entity "${entity.id}" has ${entityTotal} characters of body content; at most ${MAX_COMPOSITION_ENTITY_BODY} are allowed: shorten its blocks`,
        });
      }
    });
    if (bodyTotal > MAX_COMPOSITION_BODY) {
      ctx.addIssue({ code: "custom", path: ["entities"], message: `the bodies total ${bodyTotal} characters; at most ${MAX_COMPOSITION_BODY} are allowed: shorten or remove some` });
    }

    const entityIds = new Set(spec.entities.map((entity) => entity.id));
    spec.connections.forEach((connection, i) => {
      for (const end of ["from", "to"] as const) {
        if (!entityIds.has(connection[end])) {
          ctx.addIssue({ code: "custom", path: ["connections", i, end], message: `no entity has id "${connection[end]}": connections join declared entities` });
        }
      }
      if (connection.from === connection.to) {
        ctx.addIssue({ code: "custom", path: ["connections", i, "to"], message: `connection "${connection.id}" joins "${connection.from}" to itself: its ends must be two different entities` });
      }
    });

    const declared = { groups: spec.groups, entities: spec.entities, connections: new Map(spec.connections.map((connection) => [connection.id, connection])) };
    spec.steps.forEach((step, i) => checkStep(step, i, declared, ctx));
  });
export type CompositionSpec = z.infer<typeof CompositionSpec>;

/** A reference shown on its source card: the chip that keeps a connection readable without a drawn line. */
export interface ResolvedCompositionReference {
  connectionId: string;
  to: string;
  toLabel: string;
  label: string | undefined;
}

export interface ResolvedCompositionEntity {
  id: string;
  label: string;
  /** The properties shown at this step: the step's replacement if it has one, else the declared list. */
  properties: CompositionProperty[];
  body: CompositionBlock[];
  /** Undefined is neutral. */
  tone: CompositionTone | undefined;
  callout: string | undefined;
  /** This entity's visible outgoing connections, in declaration order. */
  references: ResolvedCompositionReference[];
}

export interface ResolvedCompositionGroup extends CompositionGroup {
  /** Top to bottom. In an ordered group, the first is the front or top. */
  entities: ResolvedCompositionEntity[];
}

export interface ResolvedCompositionStep {
  index: number;
  label: string | undefined;
  explanation: string;
  /** Every declared group in declaration order, including empty ones. */
  groups: ResolvedCompositionGroup[];
  /** The visible connections, in declaration order. */
  connections: CompositionConnection[];
}

/**
 * What one step shows, worked out from the declarations and that step alone. Shared by every renderer, so
 * stepping forward, back, seeking and resetting can't disagree. The index is clamped to the steps there are.
 */
export function resolveCompositionStep(spec: CompositionSpec, index: number): ResolvedCompositionStep {
  const at = Math.min(Math.max(Math.trunc(index) || 0, 0), spec.steps.length - 1);
  const step = spec.steps[at]!;
  const entities = new Map(spec.entities.map((entity) => [entity.id, entity]));
  const placed = new Map(step.placements.map((placement) => [placement.groupId, placement.entityIds]));
  const visibleIds = new Set([...placed.values()].flat().filter((id) => entities.has(id)));
  const shown = new Set(step.connections);
  const connections = spec.connections.filter((connection) => shown.has(connection.id) && visibleIds.has(connection.from) && visibleIds.has(connection.to));
  const state = new Map(step.state?.map((entry) => [entry.entityId, entry.properties]));
  const tones = new Map(step.emphasis?.map((entry) => [entry.entityId, entry.tone]));
  const callouts = new Map(step.callouts?.map((entry) => [entry.entityId, entry.text]));

  const resolve = (entity: CompositionEntity): ResolvedCompositionEntity => ({
    id: entity.id,
    label: entity.label,
    properties: state.get(entity.id) ?? entity.properties,
    body: entity.body ?? [],
    tone: tones.get(entity.id),
    callout: callouts.get(entity.id),
    references: connections
      .filter((connection) => connection.from === entity.id)
      .map((connection) => ({ connectionId: connection.id, to: connection.to, toLabel: entities.get(connection.to)!.label, label: connection.label })),
  });

  return {
    index: at,
    label: step.label,
    explanation: step.explanation,
    groups: spec.groups.map((group) => ({
      ...group,
      entities: (placed.get(group.id) ?? []).flatMap((id) => {
        const entity = entities.get(id);
        return entity ? [resolve(entity)] : [];
      }),
    })),
    connections,
  };
}

/**
 * One thing that differs between a step and the declared step before it. `text` is a full sentence built
 * from labels, for the non-motion summary and its polite announcement; the ids are for renderers that also
 * animate the change. `text` is MathText (labels may hold $...$); literal property names and values have
 * their dollars escaped, so they never turn into formulas.
 */
export type CompositionChange =
  | { type: "initial"; text: string }
  | { type: "appeared"; entityId: string; groupId: string; text: string }
  | { type: "hidden"; entityId: string; groupId: string; text: string }
  | { type: "moved"; entityId: string; fromGroupId: string; toGroupId: string; text: string }
  | { type: "reordered"; groupId: string; text: string }
  | { type: "property_added" | "property_removed" | "property_changed"; entityId: string; name: string; text: string }
  | { type: "connection_added" | "connection_removed"; connectionId: string; text: string };

const literal = (value: string | number | boolean) => (value === "" ? '""' : String(value).replaceAll("$", "\\$"));

/**
 * The change summary for a step: what differs from the step declared before it, whichever way the learner
 * got here. The first step describes the initial state instead. Empty when nothing visible changed.
 */
export function compositionChanges(spec: CompositionSpec, index: number): CompositionChange[] {
  const current = resolveCompositionStep(spec, index);
  const describe = (connection: CompositionConnection, labels: Map<string, string>) =>
    `${labels.get(connection.from)} → ${labels.get(connection.to)}${connection.label === undefined ? "" : ` (${connection.label})`}`;
  const labels = new Map(spec.entities.map((entity) => [entity.id, entity.label]));

  if (current.index === 0) {
    return [
      ...current.groups.map((group): CompositionChange => ({
        type: "initial",
        text: group.entities.length ? `${group.label} holds ${group.entities.map((entity) => entity.label).join(", ")}.` : `${group.label} is empty.`,
      })),
      ...current.connections.map((connection): CompositionChange => ({ type: "initial", text: `${describe(connection, labels)} is connected.` })),
    ];
  }

  const previous = resolveCompositionStep(spec, current.index - 1);
  const locate = (step: ResolvedCompositionStep) =>
    new Map(step.groups.flatMap((group) => group.entities.map((entity) => [entity.id, { group, entity }] as const)));
  const before = locate(previous);
  const after = locate(current);
  const changes: CompositionChange[] = [];

  // Entities in declaration order, so the summary reads the same however the placements were written.
  for (const { id, label } of spec.entities) {
    const was = before.get(id);
    const now = after.get(id);
    if (!was && now) changes.push({ type: "appeared", entityId: id, groupId: now.group.id, text: `${label} appears in ${now.group.label}.` });
    else if (was && !now) changes.push({ type: "hidden", entityId: id, groupId: was.group.id, text: `${label} leaves ${was.group.label}.` });
    else if (was && now && was.group.id !== now.group.id) {
      changes.push({ type: "moved", entityId: id, fromGroupId: was.group.id, toGroupId: now.group.id, text: `${label} moves from ${was.group.label} to ${now.group.label}.` });
    }
  }

  for (const group of current.groups) {
    const stayed = (entities: ResolvedCompositionEntity[]) => entities.map((entity) => entity.id).filter((id) => before.get(id)?.group.id === group.id && after.get(id)?.group.id === group.id);
    const order = stayed(group.entities);
    const earlier = stayed(previous.groups.find((other) => other.id === group.id)!.entities);
    if (order.some((id, i) => id !== earlier[i])) {
      changes.push({ type: "reordered", groupId: group.id, text: `${group.label} is reordered: ${group.entities.map((entity) => entity.label).join(", ")}.` });
    }
  }

  for (const { id, label } of spec.entities) {
    const was = before.get(id)?.entity;
    const now = after.get(id)?.entity;
    if (!was || !now) continue;
    const old = new Map(was.properties.map((property) => [property.name, property.value]));
    const names = new Set(now.properties.map((property) => property.name));
    for (const { name, value } of now.properties) {
      if (!old.has(name)) changes.push({ type: "property_added", entityId: id, name, text: `${label} gains ${literal(name)} = ${literal(value)}.` });
      else if (old.get(name) !== value) {
        changes.push({ type: "property_changed", entityId: id, name, text: `${label}: ${literal(name)} changes from ${literal(old.get(name)!)} to ${literal(value)}.` });
      }
    }
    for (const { name } of was.properties) {
      if (!names.has(name)) changes.push({ type: "property_removed", entityId: id, name, text: `${label} loses ${literal(name)}.` });
    }
  }

  const wasShown = new Set(previous.connections.map((connection) => connection.id));
  const isShown = new Set(current.connections.map((connection) => connection.id));
  for (const connection of spec.connections) {
    if (isShown.has(connection.id) && !wasShown.has(connection.id)) {
      changes.push({ type: "connection_added", connectionId: connection.id, text: `${describe(connection, labels)} is connected.` });
    } else if (wasShown.has(connection.id) && !isShown.has(connection.id)) {
      changes.push({ type: "connection_removed", connectionId: connection.id, text: `${describe(connection, labels)} is disconnected.` });
    }
  }
  return changes;
}

const DESCRIPTION =
  "Show the learner where things are: entities as cards inside named groups, the references between them, and how that changes step by step. Use it for location, sharing and changing contents, such as two variables referring to one object (aliasing), values moving through pipeline stages, or tasks moving between a queue and a stack. Declare every group, entity and connection once, then give each step as a complete snapshot: one placement for every group (entityIds may be []), every other entity in `hidden`, and the ids of the connections shown. Nothing carries over between steps, so repeat whatever still applies; `state` replaces an entity's whole property list for that step only, and without it the entity shows its declared properties again. In an ordered group the first entity is the front or top: say in the explanation which end is which. Keep it small (roughly 3-8 entities and 3-8 steps) and make each explanation say what changed and why. Never give coordinates or styles: the layout is automatic. Code in a body is inert text. Use show_graph instead for topology, state machines, flowcharts, trees and graph algorithms, show_algorithm_trace for an algorithm over a sequence, show_code_walkthrough to explain source lines, show_table for tabular comparison, and show_set_diagram or show_worked_steps for sets and proofs.";

/**
 * composition's entry for `artifactKinds`, kept out of it until the web has a renderer (#113). To activate:
 * 1. `packages/protocol/src/index.ts`: add `composition: compositionArtifactKind` to `artifactKinds` (keep
 *    the keys in order) and `CompositionArtifactView` to the `ArtifactView` union.
 * 2. `packages/protocol/src/lesson.ts`: add "composition" to `LessonSectionKind`.
 * 3. `packages/server/src/runtime/lessons.ts`: add `composition` to `toolForKind` (a type error until then).
 * 4. `packages/server/src/plugins/core-learning.ts`: `api.registerArtifactKind(compositionKindDefinition)`,
 *    from `./composition.js`. That is what offers show_composition to the model and to insert_artifact.
 * 5. `packages/web/src/artifacts/ArtifactPart.tsx`: add the renderer (a type error until then).
 * 6. Flip the "stays dormant" tests in `packages/protocol/test/composition.test.ts` and
 *    `packages/server/test/composition.test.ts`.
 */
export const compositionArtifactKind = {
  version: 1,
  toolName: "show_composition",
  description: DESCRIPTION,
  spec: CompositionSpec,
  // Code, ids, languages, property strings, step labels and display formulas are literal: no math check.
  input: artifactMathInput(CompositionSpec, [
    "title",
    "groups.*.label",
    "entities.*.label",
    "entities.*.body.*.text",
    "connections.*.label",
    "steps.*.explanation",
    "steps.*.callouts.*.text",
  ]),
} as const;

/** A composition as the client receives it. The spec has no private fields, so the view carries all of it. */
export const CompositionArtifactView = z
  .object({ id: z.string(), createdAt: z.string().datetime(), kind: z.literal("composition"), version: z.literal(1), spec: CompositionSpec })
  .strict();
export type CompositionArtifactView = z.infer<typeof CompositionArtifactView>;
