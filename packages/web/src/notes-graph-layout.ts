import type { NoteGraphView } from "@mivra/protocol";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";

/**
 * Places a notes graph (ADR-014 step 4) in the browser, never on the server or by a model, as the graph artifact
 * does: a d3-force layout run to the end once, so nothing moves afterwards and the same view always lands the
 * same way. Unlike the artifact's layout, which compares every pair, this one uses d3's Barnes–Hut repulsion,
 * since a view holds up to a thousand nodes, and spends a fixed budget of node-ticks: a large view gets fewer ticks,
 * and collisions are resolved only over the last stretch, once the shape has settled. It runs in a worker (see
 * notes-graph.worker.ts), so even a slow machine never stalls the page while it does.
 */

/** Ticks for a small view; a large one gets fewer, down to MIN_TICKS, so the cost stays near TICK_BUDGET node-ticks. */
const MAX_TICKS = 220;
const MIN_TICKS = 70;
const TICK_BUDGET = 40_000;
/** The share of ticks at the end that also push overlapping nodes apart. */
const COLLIDE_SHARE = 0.35;
const MARGIN = 40;
/** Room under a node for its label, so labels of neighbours on one row don't meet. */
const LABEL_ROOM = 14;

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  radius: number;
}
export interface NotesGraphLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  /** Index into `nodes` of each edge's ends, in the view's edge order. */
  edges: [number, number][];
}

type SimNode = SimulationNodeDatum & { index: number; radius: number; x: number; y: number };

/** A fixed-seed generator, so d3's jiggle for nodes that land on one spot is the same every time. */
function seeded(seed = 1) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** How big a node is drawn: notes grow with their connections, so hubs stand out as in Obsidian. */
export function nodeRadius(kind: NoteGraphView["nodes"][number]["kind"], degree: number) {
  if (kind === "note") return 5 + Math.min(7, Math.sqrt(degree) * 1.4);
  if (kind === "ghost") return 4;
  return 5 + Math.min(5, Math.sqrt(degree));
}

export type LayoutInput = Pick<NoteGraphView, "nodes" | "edges">;

export function layoutNotesGraph(view: LayoutInput): NotesGraphLayout {
  const indexOf = new Map(view.nodes.map((node, i) => [node.id, i]));
  const edges = view.edges.flatMap(({ from, to }) => {
    const a = indexOf.get(from);
    const b = indexOf.get(to);
    return a === undefined || b === undefined || a === b ? [] : [[a, b] as [number, number]];
  });
  const degree = view.nodes.map(() => 0);
  for (const [a, b] of edges) {
    degree[a]!++;
    degree[b]!++;
  }
  const nodes = view.nodes.map((node, index) => ({ index, radius: nodeRadius(node.kind, degree[index]!) })) as SimNode[];
  if (nodes.length > 0) {
    const crowd = Math.min(1, 60 / nodes.length);
    const ticks = Math.round(Math.min(MAX_TICKS, Math.max(MIN_TICKS, TICK_BUDGET / nodes.length)));
    const settled = Math.round(ticks * (1 - COLLIDE_SHARE));
    const simulation = forceSimulation(nodes)
      .stop()
      .randomSource(seeded())
      .alphaDecay(1 - 0.001 ** (1 / ticks))
      .force(
        "link",
        forceLink<SimNode, { source: number; target: number }>(edges.map(([source, target]) => ({ source, target })))
          .id((node) => node.index)
          .distance((link) => 26 + (link.source as unknown as SimNode).radius + (link.target as unknown as SimNode).radius),
      )
      .force("charge", forceManyBody<SimNode>().strength(-90 - 120 * crowd).theta(0.9).distanceMax(250))
      // Pulls separate pieces (lone notes, small clusters) in, so they don't drift off the edges.
      .force("x", forceX<SimNode>().strength(0.06))
      .force("y", forceY<SimNode>().strength(0.06))
      .tick(settled);
    simulation.force("collide", forceCollide<SimNode>((node) => node.radius + LABEL_ROOM).iterations(1)).tick(ticks - settled);
  }
  const xs = nodes.length > 0 ? nodes.map((n) => n.x) : [0];
  const ys = nodes.length > 0 ? nodes.map((n) => n.y) : [0];
  const left = Math.min(...xs) - MARGIN;
  const top = Math.min(...ys) - MARGIN;
  const width = Math.max(...xs) + MARGIN - left;
  const height = Math.max(...ys) + MARGIN + LABEL_ROOM - top;
  return {
    width: Math.max(width, 200),
    height: Math.max(height, 160),
    nodes: nodes.map((n, i) => ({ id: view.nodes[i]!.id, x: n.x - left, y: n.y - top, radius: n.radius })),
    edges,
  };
}
