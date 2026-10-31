import type { GraphSpec } from "@mivra/protocol";
import { forceLink, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { hierarchy, tree } from "d3-hierarchy";

/** The size labels are drawn at when the graph is at its natural size. Boxes below are measured against it. */
export const LABEL_FONT_PX = 13;
const CHAR_WIDTH = LABEL_FONT_PX * 0.6; // Node and edge labels are monospaced.
const NODE_HEIGHT = 30;
const NODE_PADDING = 18;
const LEVEL_GAP = 72;
const SIBLING_GAP = 18;
const LINK_DISTANCE = 30;
const REPULSION = 1500;
/** Past this many nodes repulsion eases off, or the largest graphs spread far beyond any screen. */
const ROOMY_NODES = 15;
const NODE_CLEARANCE = 28;
const PARALLEL_GAP = 34;
const LOOP_SIZE = 30;
const LOOP_STACK = 16;
const LOOP_SPREAD = 0.6; // Radians either side of the direction a loop points in.
const ARROW_LENGTH = 9;
const ARROW_HALF_WIDTH = 4.5;
const MARGIN = 8;
const EDGE_LABEL_HEIGHT = 18;
/** Where along its edge a label may sit, in order of preference. */
const LABEL_SPOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78];
const TICKS = 150;

interface Point {
  x: number;
  y: number;
}
interface Box extends Point {
  width: number;
  height: number;
}

export interface LaidOutNode extends Box {
  id: string;
}
export interface LaidOutEdge {
  /** SVG path data, stopping at the rims of its nodes (at the arrowhead's base if there is one). */
  path: string;
  /** SVG polygon points for the arrowhead, on directed graphs. */
  arrow?: string;
  label: Point;
}
export interface GraphLayout {
  mode: "tree" | "general";
  width: number;
  height: number;
  /** In the order of the spec's nodes and edges. */
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

type LayoutInput = Pick<GraphSpec, "directed" | "kind" | "nodes" | "edges">;

/** A label's source, roughly as wide as it renders: maths is shorter than the LaTeX that writes it. */
function labelWidth(text: string) {
  const visible = text.includes("$") ? text.replace(/\\[a-zA-Z]+/g, "x").replace(/[$_^{}\\]/g, "") : text;
  return visible.length * CHAR_WIDTH;
}

export const edgeText = (edge: GraphSpec["edges"][number]) => (edge.weight !== undefined ? String(edge.weight) : edge.label);

/** Each node's children in edge order, if the graph is a real tree: one root, connected, no cycles. */
function treeChildren(spec: LayoutInput): { root: string; children: Map<string, string[]> } | undefined {
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

function treePositions(sizes: Map<string, Box>, shape: NonNullable<ReturnType<typeof treeChildren>>) {
  const widest = Math.max(...[...sizes.values()].map((box) => box.width));
  const root = hierarchy(shape.root, (id) => shape.children.get(id));
  tree<string>().nodeSize([widest + SIBLING_GAP, LEVEL_GAP]).separation(() => 1)(root);
  root.each((node) => Object.assign(sizes.get(node.data)!, { x: node.x, y: node.y }));
}

type SimNode = SimulationNodeDatum & { id: string; radius: number; x: number; y: number; vx: number; vy: number };

/**
 * Every pair pushes apart, harder if they overlap. d3's forceManyBody and forceCollide do this through a
 * quadtree, which is built each tick and at this size costs far more than comparing every pair.
 */
const repelPairs = (nodes: SimNode[]) => (alpha: number) => {
  const strength = REPULSION * Math.min(1, ROOMY_NODES / nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const squared = dx * dx + dy * dy || 1;
      const clear = a.radius + b.radius + NODE_CLEARANCE;
      const push = (strength * alpha) / squared + (squared < clear * clear ? (clear / Math.sqrt(squared) - 1) * 0.25 : 0);
      a.vx -= dx * push;
      a.vy -= dy * push;
      b.vx += dx * push;
      b.vy += dy * push;
    }
  }
};

/** d3-force starts nodes in a fixed spiral and nothing here is random, so this is deterministic. */
function forcePositions(spec: LayoutInput, sizes: Map<string, Box>) {
  const nodes = spec.nodes.map(({ id }) => ({ id, radius: sizes.get(id)!.width / 2 })) as SimNode[];
  const pairs = new Map<string, { source: string; target: string }>();
  for (const { from, to } of spec.edges) {
    if (from !== to) pairs.set(JSON.stringify([from, to].sort()), { source: from, target: to });
  }
  const link = forceLink<SimNode, { source: string; target: string }>([...pairs.values()])
    .id((node) => node.id)
    .distance((edge) => LINK_DISTANCE + (edge.source as unknown as SimNode).radius + (edge.target as unknown as SimNode).radius);
  forceSimulation(nodes)
    .stop()
    .alphaDecay(1 - 0.001 ** (1 / TICKS))
    .force("link", link)
    .force("repel", repelPairs(nodes))
    .force("x", forceX().strength(0.05))
    .force("y", forceY().strength(0.05))
    .tick(TICKS);
  for (const node of nodes) Object.assign(sizes.get(node.id)!, { x: node.x, y: node.y });
}

/** Whether a point is inside a node's pill: a rectangle whose short sides are semicircles. */
function insideNode(box: Box, p: Point) {
  const radius = box.height / 2;
  const dx = Math.max(Math.abs(p.x - box.x) - (box.width / 2 - radius), 0);
  const dy = p.y - box.y;
  return dx * dx + dy * dy <= radius * radius;
}

/** The t in [a, b] where `isA` flips, given it holds at a and not at b. */
function bisect(a: number, b: number, isA: (t: number) => boolean) {
  for (let i = 0; i < 14; i++) {
    const mid = (a + b) / 2;
    if (isA(mid)) a = mid;
    else b = mid;
  }
  return a;
}

type Curve = (t: number) => Point;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp = (a: Point, b: Point, t: number): Point => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
const quadratic = (a: Point, c: Point, b: Point): Curve => (t) => lerp(lerp(a, c, t), lerp(c, b, t), t);
const cubic = (a: Point, c: Point, d: Point, b: Point): Curve => (t) => {
  const q = quadratic(a, c, d)(t);
  return lerp(q, quadratic(c, d, b)(t), t);
};

/** Edges are drawn as sampled curves between node centres, cut where they cross each node's rim. */
function drawEdge(curve: Curve, source: Box, target: Box, segments: number, directed: boolean) {
  const start = insideNode(source, curve(0.5)) ? 0.5 : bisect(0, 0.5, (t) => insideNode(source, curve(t)));
  const end = insideNode(target, curve(0.5)) ? 0.5 : bisect(1, 0.5, (t) => insideNode(target, curve(t)));
  const tip = curve(end);
  const base = directed ? bisect(end, start, (t) => Math.hypot(curve(t).x - tip.x, curve(t).y - tip.y) < ARROW_LENGTH) : end;
  const points = Array.from({ length: segments + 1 }, (_, i) => curve(mix(start, base, i / segments)));
  if (!directed) return { points };

  const b = curve(base);
  const length = Math.hypot(tip.x - b.x, tip.y - b.y) || 1;
  const across = { x: ((b.y - tip.y) / length) * ARROW_HALF_WIDTH, y: ((tip.x - b.x) / length) * ARROW_HALF_WIDTH };
  const arrow = [tip, { x: b.x + across.x, y: b.y + across.y }, { x: b.x - across.x, y: b.y - across.y }];
  return { points, arrow };
}

/** How far a ray from the node's centre travels before it leaves the pill. */
function rimDistance(box: Box, ux: number, uy: number) {
  return bisect(0, box.width + box.height, (d) => insideNode(box, { x: box.x + ux * d, y: box.y + uy * d }));
}

const overlaps = (a: Box, b: Box) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2;

const fixed = (n: number) => Math.round(n * 100) / 100;
const pointsText = (points: Point[], shift: Point) => points.map((p) => `${fixed(p.x + shift.x)},${fixed(p.y + shift.y)}`);

/**
 * Where everything goes, in px at the graph's natural size. Pure and independent of the steps, so a graph
 * never moves while it's stepped through. A tree uses d3's tidy layout, which keeps children in edge order
 * (left and right matter in a traversal); anything else uses a force layout run to the end up front.
 */
export function layoutGraph(spec: LayoutInput): GraphLayout {
  const boxes = new Map<string, Box>(
    spec.nodes.map((node) => [
      node.id,
      { x: 0, y: 0, width: Math.max(NODE_HEIGHT, labelWidth(node.label ?? node.id) + NODE_PADDING), height: NODE_HEIGHT },
    ]),
  );
  const shape = spec.kind === "tree" ? treeChildren(spec) : undefined;
  if (shape) treePositions(boxes, shape);
  else forcePositions(spec, boxes);

  const all = [...boxes.values()];
  const centre = { x: all.reduce((sum, b) => sum + b.x, 0) / all.length, y: all.reduce((sum, b) => sum + b.y, 0) / all.length };
  const ordinal = new Map(spec.nodes.map((node, i) => [node.id, i]));
  const pairKey = (from: string, to: string) => (ordinal.get(from)! <= ordinal.get(to)! ? `${ordinal.get(from)}:${ordinal.get(to)}` : `${ordinal.get(to)}:${ordinal.get(from)}`);
  const total = new Map<string, number>();
  for (const { from, to } of spec.edges) total.set(pairKey(from, to), (total.get(pairKey(from, to)) ?? 0) + 1);
  const seen = new Map<string, number>();

  const drawn = spec.edges.map((edge) => {
    const key = pairKey(edge.from, edge.to);
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const source = boxes.get(edge.from)!;
    const target = boxes.get(edge.to)!;

    if (edge.from === edge.to) {
      // Loops point away from the rest of the graph, nested if a node has several.
      const away = Math.hypot(source.x - centre.x, source.y - centre.y) > 1 ? Math.atan2(source.y - centre.y, source.x - centre.x) : -Math.PI / 2;
      const reach = rimDistance(source, Math.cos(away), Math.sin(away)) + LOOP_SIZE + nth * LOOP_STACK;
      const handle = reach / (0.75 * Math.cos(LOOP_SPREAD));
      const toward = (angle: number) => ({ x: source.x + Math.cos(angle) * handle, y: source.y + Math.sin(angle) * handle });
      const curve = cubic(source, toward(away - LOOP_SPREAD), toward(away + LOOP_SPREAD), source);
      return { ...drawEdge(curve, source, source, 24, spec.directed), curve };
    }

    // Bend parallel edges apart. The bend is measured against the pair's own order, not the edge's
    // direction, so a->b and b->a go to opposite sides. The curve's peak is half its control point's offset.
    const count = total.get(key)!;
    const [a, b] = ordinal.get(edge.from)! <= ordinal.get(edge.to)! ? [source, target] : [target, source];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const offset = (nth - (count - 1) / 2) * PARALLEL_GAP * 2;
    const middle = lerp(source, target, 0.5);
    const control = { x: middle.x + ((a.y - b.y) / length) * offset, y: middle.y + ((b.x - a.x) / length) * offset };
    const curve = quadratic(source, control, target);
    return { ...drawEdge(curve, source, target, count > 1 ? 16 : 1, spec.directed), curve };
  });

  // A label hidden behind a node or another label would lose a weight, so each takes the first free spot.
  const taken: Box[] = [...all];
  const labels = drawn.map((edge, i) => {
    const text = edgeText(spec.edges[i]!);
    const size = { width: (text ? labelWidth(text) : 0) + 8, height: EDGE_LABEL_HEIGHT };
    const spots = LABEL_SPOTS.map((t) => ({ ...edge.curve(t), ...size }));
    if (!text) return spots[0]!;
    const clashes = spots.map((spot) => taken.filter((box) => overlaps(box, spot)).length);
    const best = spots[clashes.indexOf(Math.min(...clashes))]!;
    taken.push(best);
    return best;
  });

  // Fit the box around everything drawn, including edge labels.
  const extents: Box[] = [...all, ...labels.filter((_, i) => edgeText(spec.edges[i]!))];
  for (const edge of drawn) extents.push(...edge.points.map((p) => ({ ...p, width: 0, height: 0 })));
  const left = Math.min(...extents.map((b) => b.x - b.width / 2)) - MARGIN;
  const top = Math.min(...extents.map((b) => b.y - b.height / 2)) - MARGIN;
  const right = Math.max(...extents.map((b) => b.x + b.width / 2)) + MARGIN;
  const bottom = Math.max(...extents.map((b) => b.y + b.height / 2)) + MARGIN;
  const shift = { x: -left, y: -top };

  return {
    mode: shape ? "tree" : "general",
    width: Math.ceil(right - left),
    height: Math.ceil(bottom - top),
    nodes: spec.nodes.map(({ id }) => {
      const box = boxes.get(id)!;
      return { id, x: fixed(box.x + shift.x), y: fixed(box.y + shift.y), width: box.width, height: box.height };
    }),
    edges: drawn.map((edge, i) => ({
      path: `M${pointsText(edge.points, shift).join("L")}`,
      ...(edge.arrow ? { arrow: pointsText(edge.arrow, shift).join(" ") } : {}),
      label: { x: fixed(labels[i]!.x + shift.x), y: fixed(labels[i]!.y + shift.y) },
    })),
  };
}
