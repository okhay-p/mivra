import { graphTreeShape, type GraphSpec } from "@mivra/protocol";
import { forceLink, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { hierarchy, tree } from "d3-hierarchy";

/** The size labels are drawn at when the graph is at its natural size. Boxes below are measured against it. */
export const LABEL_FONT_PX = 13;
const CHAR_WIDTH = LABEL_FONT_PX * 0.6; // Node and edge labels are monospaced.
/** These take a full em even in a monospaced font, as they fall back to a font with square glyphs. */
const WIDE_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60]/gu;
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
const EDGE_LABEL_GAP = 4;
/** Where along its edge a label may sit, in order of preference. */
const LABEL_SPOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78];
/** How many label-sized steps away from its edge a label may go, if nowhere along it is free. */
const LABEL_STEPS_ASIDE = 6;
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
  /** Where its label goes and the room it has. The label is clipped to this, so the layout can rely on it. */
  label: Box;
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
type GraphShape = NonNullable<ReturnType<typeof graphTreeShape>>;

/** Budget one KaTeX em per visible formula character, including room for operator spacing.
 * Commands represent one glyph; escaped delimiters remain visible, grouping braces do not.
 * Cap formula runs at twelve em: genuine outliers still clip inside deterministic boxes.
 */
function labelWidth(text: string) {
  const plainWidth = (value: string) => value.length * CHAR_WIDTH + (value.match(WIDE_CHARS)?.length ?? 0) * (LABEL_FONT_PX - CHAR_WIDTH);
  let width = 0;
  let end = 0;
  for (const match of text.matchAll(/\$([^$]+)\$/g)) {
    width += plainWidth(text.slice(end, match.index));
    const visible = match[1]!.replace(/\\(?:text|mathrm|mathbf|mathbb|mathit)\b/g, "")
      .replace(/\\[a-zA-Z]+|\\[^a-zA-Z]/g, "x").replace(/[_^{}\s]/g, "");
    width += Math.min(visible.length, 12) * LABEL_FONT_PX * 1.1 + 4;
    end = match.index + match[0].length;
  }
  return width + plainWidth(text.slice(end));
}

export const edgeText = (edge: GraphSpec["edges"][number]) => (edge.weight !== undefined ? String(edge.weight) : edge.label);
const edgeLabelWidth = (text: string | undefined) => (text ? labelWidth(text) : 0) + 8;

/** d3's tidy layout, for a tree with no sides: children stay in edge order. */
function tidyPositions(sizes: Map<string, Box>, shape: GraphShape) {
  const widest = Math.max(...[...sizes.values()].map((box) => box.width));
  const root = hierarchy(shape.root, (id) => shape.children.get(id));
  tree<string>().nodeSize([widest + SIBLING_GAP, LEVEL_GAP]).separation(() => 1)(root);
  root.each((node) => Object.assign(sizes.get(node.data)!, { x: node.x, y: node.y }));
}

/**
 * A tree with sides gets one column per node, in inorder, so a left subtree is wholly left of its parent and a
 * right subtree wholly right, however deep: the page reads as a BST's sorted order. Nodes next to each other in
 * inorder are always on different levels, so nodes on one level are two columns apart at least, and an edge
 * can't cross a node. The schema lets a node without sides sit in such a tree: its children stay in edge order,
 * a column apart so that still holds, with the node centred over them.
 */
function inorderPositions(spec: LayoutInput, sizes: Map<string, Box>, shape: GraphShape) {
  const sideOf = new Map(spec.edges.map((edge) => [edge.to, edge.side]));
  const widest = Math.max(...[...sizes.values()].map((box) => box.width));
  // Two children's edges are a column apart halfway down, which is where their labels go.
  const widestLabel = Math.max(0, ...spec.edges.map((edge) => edgeLabelWidth(edgeText(edge))));
  const column = Math.max((widest + SIBLING_GAP) / 2, widestLabel + EDGE_LABEL_GAP);
  const columnOf = new Map<string, number>();

  /** Places a subtree in the columns from `start`, and returns the column after them. */
  const place = (id: string, depth: number, start: number): number => {
    const children = shape.children.get(id)!;
    const box = sizes.get(id)!;
    let end: number;
    if (children.some((child) => sideOf.get(child))) {
      const left = children.find((child) => sideOf.get(child) === "left");
      const right = children.find((child) => sideOf.get(child) === "right");
      const own = left === undefined ? start : place(left, depth + 1, start);
      columnOf.set(id, own);
      end = right === undefined ? own + 1 : place(right, depth + 1, own + 1);
    } else {
      end = children.reduce((next, child, i) => place(child, depth + 1, next + (i > 0 ? 1 : 0)), start);
      const first = children[0];
      const last = children.at(-1);
      columnOf.set(id, first === undefined || last === undefined ? start : (columnOf.get(first)! + columnOf.get(last)!) / 2);
      end = Math.max(end, start + 1);
    }
    Object.assign(box, { x: columnOf.get(id)! * column, y: depth * LEVEL_GAP });
    return end;
  };
  place(shape.root, 0, 0);
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
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edgePairs = [...pairs.values()].map(({ source, target }) => [byId.get(source)!, byId.get(target)!] as const);
  const repelEdges = () => {
    for (const [a, b] of edgePairs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      for (const node of nodes) {
        if (node === a || node === b) continue;
        const t = Math.max(0, Math.min(1, ((node.x - a.x) * dx + (node.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const px = node.x - a.x - t * dx;
        const py = node.y - a.y - t * dy;
        const distance = Math.hypot(px, py);
        const push = Math.max(0, node.radius + 12 - distance) * 0.5;
        const ux = distance > 0.001 ? px / distance : -dy / (Math.hypot(dx, dy) || 1);
        const uy = distance > 0.001 ? py / distance : dx / (Math.hypot(dx, dy) || 1);
        node.vx += ux * push;
        node.vy += uy * push;
        a.vx -= ux * push * (1 - t);
        a.vy -= uy * push * (1 - t);
        b.vx -= ux * push * t;
        b.vy -= uy * push * t;
      }
    }
  };
  const link = forceLink<SimNode, { source: string; target: string }>([...pairs.values()])
    .id((node) => node.id)
    .distance((edge) => LINK_DISTANCE + (edge.source as unknown as SimNode).radius + (edge.target as unknown as SimNode).radius);
  forceSimulation(nodes)
    .stop()
    .alphaDecay(1 - 0.001 ** (1 / TICKS))
    .force("link", link)
    .force("repel", repelPairs(nodes))
    .force("edgeClearance", repelEdges)
    .force("x", forceX().strength(0.05))
    .force("y", forceY().strength(0.05))
    .tick(TICKS);
  for (const node of nodes) Object.assign(sizes.get(node.id)!, { x: node.x, y: node.y });
}

/** Closest distance to a centre-to-centre segment, including its endpoints. */
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/**
 * Keep the force/tidy shape when it has room. Near-collinear force layouts fall back to a convex polygon:
 * no chord can contain a third vertex. Scaling then gives every node a circumscribed radius plus 6px,
 * reserving the entire bend/loop envelope too. Dense graphs may cross edges and need a scrolling canvas;
 * clearance takes priority over compactness, with no random retries or unbounded relaxation loop.
 */
function clearEdgePositions(spec: LayoutInput, boxes: Map<string, Box>, isTree: boolean) {
  const pairs = new Map<string, number>();
  const key = (from: string, to: string) => JSON.stringify([from, to].sort());
  for (const edge of spec.edges) pairs.set(key(edge.from, edge.to), (pairs.get(key(edge.from, edge.to)) ?? 0) + 1);
  const requiredScale = () => {
    let scale = 1;
    for (const edge of spec.edges) {
      const source = boxes.get(edge.from)!;
      const target = boxes.get(edge.to)!;
      const count = pairs.get(key(edge.from, edge.to))!;
      for (const [id, node] of boxes) {
        if (id === edge.from || id === edge.to) continue;
        const distance = edge.from === edge.to ? Math.hypot(node.x - source.x, node.y - source.y) : segmentDistance(node, source, target);
        const envelope = (edge.from === edge.to ? source.width / 2 + LOOP_SIZE + (count - 1) * LOOP_STACK : (count - 1) * PARALLEL_GAP / 2) + (spec.directed ? ARROW_HALF_WIDTH : 0);
        scale = Math.max(scale, (node.width / 2 + 6.1 + envelope) / Math.max(distance, 0.0001));
      }
    }
    return scale;
  };
  let scale = requiredScale();
  if (!isTree && scale > 3) {
    const radius = Math.max(80, ...[...boxes.values()].map((box) => box.width)) * boxes.size / Math.PI;
    spec.nodes.forEach(({ id }, i) => {
      const angle = 2 * Math.PI * i / boxes.size - Math.PI / 2;
      Object.assign(boxes.get(id)!, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
    scale = requiredScale();
  }
  if (scale > 1) for (const box of boxes.values()) { box.x *= scale; box.y *= scale; }
  // Clearance can stretch a small graph horizontally. Rotate general layouts towards their narrowest
  // axis so they can still fit a phone; rotation preserves all the circular clearance bounds above.
  if (!isTree && scale > 1) {
    const all = [...boxes.values()];
    let best = Infinity;
    let angle = 0;
    for (let step = 0; step < 36; step++) {
      const candidate = step * Math.PI / 36;
      const xs = all.map((box) => box.x * Math.cos(candidate) - box.y * Math.sin(candidate));
      const width = Math.max(...xs.map((x, i) => x + all[i]!.width / 2)) - Math.min(...xs.map((x, i) => x - all[i]!.width / 2));
      if (width < best - 0.01) { best = width; angle = candidate; }
    }
    for (const box of all) {
      const { x, y } = box;
      box.x = x * Math.cos(angle) - y * Math.sin(angle);
      box.y = x * Math.sin(angle) + y * Math.cos(angle);
    }
  }
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
 * never moves while it's stepped through. A tree with sides is laid out in inorder, any other tree by d3's tidy
 * layout, and anything else by a force layout run to the end up front.
 */
export function layoutGraph(spec: LayoutInput): GraphLayout {
  const boxes = new Map<string, Box>(
    spec.nodes.map((node) => [
      node.id,
      { x: 0, y: 0, width: Math.max(NODE_HEIGHT, labelWidth(node.label ?? node.id) + NODE_PADDING), height: NODE_HEIGHT },
    ]),
  );
  const shape = spec.kind === "tree" ? graphTreeShape(spec) : undefined;
  if (!shape) forcePositions(spec, boxes);
  else if (spec.edges.some((edge) => edge.side)) inorderPositions(spec, boxes, shape);
  else tidyPositions(boxes, shape);
  clearEdgePositions(spec, boxes, !!shape);

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
    const size = { width: edgeLabelWidth(text), height: EDGE_LABEL_HEIGHT };
    const spots = LABEL_SPOTS.map((t) => ({ ...edge.curve(t), ...size }));
    if (!text) return spots[0]!;
    const clashes = spots.map((spot) => taken.filter((box) => overlaps(box, spot)).length);
    const along = spots[clashes.indexOf(Math.min(...clashes))]!;
    // Between two wide nodes nowhere on the edge may be free, so it sits beside it, nearest first. Not a weight:
    // those are short, and in a graph dense enough to leave them no room this would only spread it further.
    const aside = Array.from({ length: LABEL_STEPS_ASIDE }, (_, step) => step + 1).flatMap((step) => {
      const [dy, dx] = [step * (size.height + EDGE_LABEL_GAP), step * (size.width + EDGE_LABEL_GAP)];
      return [{ ...spots[0]!, y: spots[0]!.y - dy }, { ...spots[0]!, y: spots[0]!.y + dy }, { ...spots[0]!, x: spots[0]!.x - dx }, { ...spots[0]!, x: spots[0]!.x + dx }];
    });
    const best = Math.min(...clashes) === 0 || spec.edges[i]!.weight !== undefined ? along : (aside.find((spot) => !taken.some((box) => overlaps(box, spot))) ?? along);
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
      label: { x: fixed(labels[i]!.x + shift.x), y: fixed(labels[i]!.y + shift.y), width: labels[i]!.width, height: labels[i]!.height },
    })),
  };
}
