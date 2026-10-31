import { z } from "zod";
import { TraceVariable } from "./algorithm-trace.js";

/**
 * graph v1: nodes and edges, optionally with steps that walk an algorithm over them. Covers BFS, DFS,
 * shortest paths, spanning trees and tree traversals. Self-loops and parallel edges are allowed and
 * drawn, because a multigraph is ordinary discrete maths. The model never picks coordinates: the
 * renderer computes one layout per graph, so nothing moves between steps.
 *
 * State rules (renderers must follow them):
 * - The graph itself never changes between steps.
 * - `nodeStates`, `edgeStates` and `variables` do not persist: each step lists all of its own, and
 *   omitting one means that step has none. So every step is fully described by itself.
 */

const MAX_NODES = 60;
const MAX_EDGES = 200;
const MAX_STEPS = 200;

const Id = z.string().trim().min(1).max(24);
const Text = z.string().trim().min(1).max(24);

export const GraphTone = z.enum(["active", "done", "muted"]);
export type GraphTone = z.infer<typeof GraphTone>;

const ToneField = GraphTone.optional().describe(
  "active = current focus, done = finished/visited, muted = ruled out. Defaults to active.",
);

export const GraphNode = z
  .object({
    id: Id.describe("Unique id, used by edges and steps. Shown on the node if it has no label."),
    label: Text.optional().describe("Short text on the node. Only $...$ is a formula, e.g. $v_1$."),
  })
  .strict();

export const GraphEdge = z
  .object({
    from: Id.describe("Id of a node. In a tree, the parent."),
    to: Id.describe("Id of a node, the same as `from` for a self-loop. In a tree, the child; children appear left to right in edge order unless they have a `side`."),
    side: z
      .enum(["left", "right"])
      .optional()
      .describe(
        "Only when kind is tree: which child this is of `from`, its parent. Set it on every edge of a binary search tree or binary tree traversal, because a lone left child and a lone right child are different trees. A node has at most one child per side, and either all of its children have a side or none do.",
      ),
    weight: z.number().optional().describe("Numeric weight shown on the edge. Give a weight or a label, not both."),
    label: Text.optional().describe("Text shown on the edge. Only $...$ is a formula."),
  })
  .strict();

export const GraphNodeState = z
  .object({ id: Id.describe("Id of a node."), tone: ToneField })
  .strict();

export const GraphEdgeState = z
  .object({
    from: Id,
    to: Id,
    nth: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Only for parallel edges, and then required: which of the edges joining these nodes, 0-based in the order of `edges`."),
    tone: ToneField,
  })
  .strict()
  .describe("An edge of the graph. In an undirected graph, from and to may be in either order.");

export const GraphStep = z
  .object({
    explanation: z.string().trim().min(1).max(500).describe("What happens in this step, in one or two sentences."),
    nodeStates: z
      .array(GraphNodeState)
      .max(MAX_NODES)
      .optional()
      .describe("The state of every node that has one at this step, at most one each. Not carried over from earlier steps: repeat any that still apply."),
    edgeStates: z
      .array(GraphEdgeState)
      .max(MAX_EDGES)
      .optional()
      .describe("The state of every edge that has one at this step, at most one each. Not carried over from earlier steps: repeat any that still apply."),
    variables: z
      .array(TraceVariable)
      .max(12)
      .optional()
      .describe("All running state at this step, e.g. the queue or current distances. Not carried over from earlier steps."),
  })
  .strict();

const pairKey = (from: string, to: string, directed: boolean) =>
  JSON.stringify(directed || from <= to ? [from, to] : [to, from]);

/**
 * Finds which edge a step's edge state refers to, shared by the schema and renderers so they can't
 * disagree. Returns the index into `edges`, or why there isn't one.
 */
export function graphEdgeLookup(spec: { directed: boolean; edges: readonly { from: string; to: string }[] }) {
  const byPair = new Map<string, number[]>();
  spec.edges.forEach((edge, i) => {
    const key = pairKey(edge.from, edge.to, spec.directed);
    const indices = byPair.get(key);
    if (indices) indices.push(i);
    else byPair.set(key, [i]);
  });
  return (ref: { from: string; to: string; nth?: number | undefined }): { index: number } | { error: string } => {
    const name = `${ref.from} ${spec.directed ? "->" : "--"} ${ref.to}`;
    const indices = byPair.get(pairKey(ref.from, ref.to, spec.directed));
    if (!indices) return { error: `there is no edge ${name}` };
    if (ref.nth === undefined && indices.length > 1) return { error: `${indices.length} edges match ${name}: set nth to pick one` };
    const index = indices[ref.nth ?? 0];
    return index === undefined ? { error: `nth ${ref.nth} is out of range: ${indices.length} edges match ${name}` } : { index };
  };
}

/**
 * Each node's children in edge order, if the graph is a real tree: one root, connected, no cycles. Shared by
 * the schema and renderers so they can't disagree. Every edge must join nodes that exist.
 */
export function graphTreeShape(spec: {
  directed: boolean;
  nodes: readonly { id: string }[];
  edges: readonly { from: string; to: string }[];
}): { root: string; children: Map<string, string[]> } | undefined {
  if (spec.edges.length !== spec.nodes.length - 1) return undefined;
  const ids = spec.nodes.map((node) => node.id);
  const adjacent = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { from, to } of spec.edges) {
    adjacent.get(from)!.push(to);
    if (!spec.directed && from !== to) adjacent.get(to)!.push(from);
  }
  const roots = spec.directed ? ids.filter((id) => !spec.edges.some((edge) => edge.to === id)) : ids.slice(0, 1);
  const root = roots[0];
  if (roots.length !== 1 || root === undefined) return undefined;

  const children = new Map<string, string[]>();
  const pending = [root];
  while (pending.length) {
    const id = pending.pop()!;
    const next = adjacent.get(id)!.filter((other) => !children.has(other));
    children.set(id, next);
    pending.push(...next);
  }
  // With n - 1 edges, reaching all n nodes means there can't be a cycle.
  return children.size === ids.length ? { root, children } : undefined;
}

/** The rules for `side`, which only says anything about a tree that really gets drawn as one. */
function checkSides(spec: Pick<GraphSpec, "kind" | "directed" | "nodes" | "edges">, ctx: z.RefinementCtx) {
  const sided = spec.edges.flatMap((edge, i) => (edge.side ? [{ edge, side: edge.side, path: ["edges", i, "side"] }] : []));
  const first = sided[0];
  if (!first) return;
  if (spec.kind !== "tree") {
    for (const { path } of sided) ctx.addIssue({ code: "custom", path, message: 'side only applies when kind is "tree": remove it, or set kind' });
    return;
  }
  const shape = graphTreeShape(spec);
  if (!shape) {
    ctx.addIssue({ code: "custom", path: first.path, message: "side needs a real tree: connected with no cycles, and when directed, edges going parent to child from one root" });
    return;
  }
  const sideOf = new Map<string, "left" | "right">();
  for (const { edge, side, path } of sided) {
    if (shape.children.get(edge.from)!.includes(edge.to)) sideOf.set(edge.to, side);
    else ctx.addIssue({ code: "custom", path, message: `side needs from to be the parent, but ${edge.to} is the parent of ${edge.from} here: swap them` });
  }
  for (const [parent, children] of shape.children) {
    const sides = children.flatMap((child) => sideOf.get(child) ?? []);
    if (sides.length > 0 && sides.length < children.length) {
      ctx.addIssue({ code: "custom", path: ["edges"], message: `node ${parent} mixes children with and without a side: give all of them one, or none` });
    }
    for (const side of ["left", "right"] as const) {
      if (sides.filter((s) => s === side).length > 1) ctx.addIssue({ code: "custom", path: ["edges"], message: `node ${parent} has two ${side} children` });
    }
  }
}

export const GraphSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    directed: z.boolean().describe("True draws arrowheads from `from` to `to`."),
    kind: z
      .enum(["tree", "graph"])
      .optional()
      .describe(
        "Layout hint. tree draws a rooted tree top-down, and needs a real tree: connected with no cycles, and when directed, edges going parent to child from one root. When undirected, the first node is the root. Anything else falls back to the general layout, unless an edge has a `side`, which is then an error. Defaults to graph.",
      ),
    nodes: z.array(GraphNode).min(1).max(MAX_NODES),
    edges: z.array(GraphEdge).max(MAX_EDGES).describe("Self-loops and parallel edges are allowed."),
    steps: z.array(GraphStep).min(1).max(MAX_STEPS).optional().describe("Omit to show the graph without stepping through it."),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    spec.nodes.forEach((node, i) => {
      if (ids.has(node.id)) ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `duplicate node id ${node.id}` });
      ids.add(node.id);
    });
    spec.edges.forEach((edge, i) => {
      for (const end of ["from", "to"] as const) {
        if (!ids.has(edge[end])) ctx.addIssue({ code: "custom", path: ["edges", i, end], message: `no node has id ${edge[end]}` });
      }
      if (edge.weight !== undefined && edge.label !== undefined) {
        ctx.addIssue({ code: "custom", path: ["edges", i], message: "give a weight or a label, not both" });
      }
    });
    if (spec.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))) checkSides(spec, ctx);
    const lookup = graphEdgeLookup(spec);
    spec.steps?.forEach((step, i) => {
      const seenNodes = new Set<string>();
      step.nodeStates?.forEach((state, j) => {
        const path = ["steps", i, "nodeStates", j];
        if (!ids.has(state.id)) ctx.addIssue({ code: "custom", path, message: `no node has id ${state.id}` });
        if (seenNodes.has(state.id)) ctx.addIssue({ code: "custom", path, message: `node ${state.id} has two states in one step` });
        seenNodes.add(state.id);
      });
      const seenEdges = new Set<number>();
      step.edgeStates?.forEach((state, j) => {
        const path = ["steps", i, "edgeStates", j];
        const found = lookup(state);
        if ("error" in found) return ctx.addIssue({ code: "custom", path, message: found.error });
        if (seenEdges.has(found.index)) ctx.addIssue({ code: "custom", path, message: `edge ${found.index} has two states in one step` });
        seenEdges.add(found.index);
      });
    });
  });

export type GraphSpec = z.infer<typeof GraphSpec>;
export type GraphStep = z.infer<typeof GraphStep>;
