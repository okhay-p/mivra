/**
 * Where a composition's drawn connectors go (#114). Pure, so it's tested without a browser: the component measures
 * the cards and the other things a line must not cross, in pixels from the top left of the groups grid, and gets
 * back a path for each connection it can draw legibly. Anything it can't draw keeps only its chip, which every
 * visible connection has anyway, so a connector is never the only way to see a relation.
 *
 * Lines are orthogonal and stay in the gaps between cards. A connection between cards side by side runs through
 * the gutter between them; one between cards in the same column runs down their right-hand margin. Every
 * segment is checked against every other card and obstacle, and a route that would cross one isn't drawn.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConnectorRequest {
  id: string;
  from: string;
  to: string;
}

export interface Connector {
  id: string;
  /** SVG path data for the line, ending where the arrowhead's tip is. */
  path: string;
  /** SVG polygon points for the arrowhead at the target. */
  arrow: string;
  points: Point[];
}

export interface Point {
  x: number;
  y: number;
}

export interface ConnectorLayout {
  /** Below this width only chips are shown: one column leaves no room for a line beside the cards. */
  narrow: boolean;
  connectors: Connector[];
}

/** The narrowest grid that draws lines: two 220px columns and the gap between them. */
export const MIN_CONNECTOR_WIDTH = 452;
/** How far a line keeps from a card or obstacle it isn't attached to. */
const CLEARANCE = 3;
/** Space between two lines sharing a gutter or margin, and between two ends on one side of a card. */
const LANE = 5;
/** The first lane in a card's right margin is this far out, so the arrowhead fits between it and the card. */
const MARGIN_LANE = 8;
const ARROW_LENGTH = 6;
const ARROW_HALF_WIDTH = 3.5;
/** Where on a card's side the first end goes: about the middle of its label line. */
const ANCHOR_TOP = 14;

const right = (box: Box) => box.x + box.width;
const bottom = (box: Box) => box.y + box.height;
const round = (n: number) => Math.round(n * 10) / 10;

/** Whether a horizontal or vertical segment passes through a box grown by the clearance. */
function crosses(a: Point, b: Point, box: Box) {
  const [x1, x2] = a.x <= b.x ? [a.x, b.x] : [b.x, a.x];
  const [y1, y2] = a.y <= b.y ? [a.y, b.y] : [b.y, a.y];
  return x2 > box.x - CLEARANCE && x1 < right(box) + CLEARANCE && y2 > box.y - CLEARANCE && y1 < bottom(box) + CLEARANCE;
}

type Side = "left" | "right";

/** The order of a card's ends on one side, so two lines leaving or entering it don't share a point. */
class Anchors {
  private used = new Map<string, number>();
  next(id: string, side: Side, box: Box): number | undefined {
    const key = `${side}\u0000${id}`;
    const n = this.used.get(key) ?? 0;
    this.used.set(key, n + 1);
    const y = box.y + Math.min(ANCHOR_TOP, box.height / 2) + n * LANE;
    // An end below the card's bottom edge would look attached to whatever is under it.
    return y <= bottom(box) - CLEARANCE || n === 0 ? y : undefined;
  }
}

/**
 * Lays out the connectors for one step. `cards` are the visible entities' boxes by id; `obstacles` are the other
 * things a line mustn't cross, such as group headings. Requests whose cards weren't measured are skipped.
 */
export function routeConnectors(width: number, height: number, cards: ReadonlyMap<string, Box>, obstacles: readonly Box[], requests: readonly ConnectorRequest[]): ConnectorLayout {
  if (width < MIN_CONNECTOR_WIDTH) return { narrow: true, connectors: [] };
  const anchors = new Anchors();
  const lanes = new Map<string, number>();
  const lane = (key: string) => {
    const n = lanes.get(key) ?? 0;
    lanes.set(key, n + 1);
    return n;
  };
  const connectors: Connector[] = [];

  for (const request of requests) {
    const source = cards.get(request.from);
    const target = cards.get(request.to);
    if (!source || !target || request.from === request.to) continue;
    if (!(source.width > 0 && source.height > 0 && target.width > 0 && target.height > 0)) continue;

    let points: Point[] | undefined;
    if (right(source) + 2 * ARROW_LENGTH <= target.x || right(target) + 2 * ARROW_LENGTH <= source.x) {
      // Side by side: out of the facing side, along the gutter, into the target's facing side.
      const toRight = right(source) <= target.x;
      const [gapStart, gapEnd] = toRight ? [right(source), target.x] : [right(target), source.x];
      const n = lane(`g\u0000${Math.round(gapStart)}\u0000${Math.round(gapEnd)}`);
      // Lanes fan out from the middle of the gutter: 0, +1, -1, +2, ...
      const offset = (n % 2 === 0 ? n / 2 : -(n + 1) / 2) * LANE;
      const x = (gapStart + gapEnd) / 2 + offset;
      const sy = anchors.next(request.from, toRight ? "right" : "left", source);
      const ty = anchors.next(request.to, toRight ? "left" : "right", target);
      const room = x - gapStart >= ARROW_LENGTH + 1 && gapEnd - x >= ARROW_LENGTH + 1;
      if (sy !== undefined && ty !== undefined && room) {
        const sx = toRight ? right(source) : source.x;
        const tx = toRight ? target.x : right(target);
        points = [
          { x: sx, y: sy },
          { x, y: sy },
          { x, y: ty },
          { x: tx, y: ty },
        ];
      }
    } else if (bottom(source) <= target.y || bottom(target) <= source.y) {
      // One above the other: out of the right side, down the margin, back into the target's right side.
      const edge = Math.max(right(source), right(target));
      const x = edge + MARGIN_LANE + lane(`m\u0000${Math.round(edge)}`) * LANE;
      const sy = anchors.next(request.from, "right", source);
      const ty = anchors.next(request.to, "right", target);
      if (sy !== undefined && ty !== undefined && x <= width - 1) {
        points = [
          { x: right(source), y: sy },
          { x, y: sy },
          { x, y: ty },
          { x: right(target), y: ty },
        ];
      }
    }
    if (!points) continue;

    // The first segment starts on the source and the last ends on the target; nothing else may touch either.
    const others = [...[...cards].filter(([id]) => id !== request.from && id !== request.to).map(([, box]) => box), ...obstacles];
    const segments = points.slice(1).map((end, i) => [points[i]!, end] as const);
    const clear = segments.every(([a, b], i) => {
      if (others.some((box) => crosses(a, b, box))) return false;
      // The middle segment is between the two cards, so it mustn't touch them either.
      const own = i === 0 ? [target] : i === segments.length - 1 ? [source] : [source, target];
      return !own.some((box) => crosses(a, b, box));
    });
    if (!clear || points.some((p) => p.x < 0 || p.y < 0 || p.x > width || p.y > height)) continue;
    connectors.push(draw(request.id, points));
  }
  return { narrow: false, connectors };
}

function draw(id: string, points: Point[]): Connector {
  const tip = points.at(-1)!;
  const before = points.at(-2)!;
  const length = Math.hypot(tip.x - before.x, tip.y - before.y) || 1;
  const [dx, dy] = [(tip.x - before.x) / length, (tip.y - before.y) / length];
  const base = { x: tip.x - dx * ARROW_LENGTH, y: tip.y - dy * ARROW_LENGTH };
  const corners = [tip, { x: base.x - dy * ARROW_HALF_WIDTH, y: base.y + dx * ARROW_HALF_WIDTH }, { x: base.x + dy * ARROW_HALF_WIDTH, y: base.y - dx * ARROW_HALF_WIDTH }];
  // The line stops at the arrowhead's base, so its round cap doesn't poke past the tip.
  const line = [...points.slice(0, -1), base];
  return {
    id,
    path: line.map((p, i) => `${i ? "L" : "M"}${round(p.x)} ${round(p.y)}`).join(" "),
    arrow: corners.map((p) => `${round(p.x)},${round(p.y)}`).join(" "),
    points,
  };
}
