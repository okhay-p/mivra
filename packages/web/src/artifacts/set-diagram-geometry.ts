/**
 * Fixed drawings for Venn diagrams of 1, 2 and 3 sets. A region is a bitmask: bit i is set when the region
 * is inside `circles[i]`, so 0 is outside every circle.
 *
 * Each region's outline is computed as a closed path of circular arcs, which makes it its exact shape: it
 * can be filled and outlined without touching a neighbour, and tested for what it covers.
 */

export interface Point {
  x: number;
  y: number;
}

/** Where a region's contents go. `width` and `rows` describe a box that stays inside the region. */
export interface RegionSlot extends Point {
  width: number;
  rows: number;
}

export interface VennLayout {
  width: number;
  height: number;
  radius: number;
  circles: Point[];
  /** Keyed by region mask; 0 is the bottom right corner. */
  slots: Record<number, RegionSlot>;
}

const WIDTH = 380;
const RADIUS = 100;

export const VENN_LAYOUTS: Record<number, VennLayout> = {
  1: {
    width: WIDTH,
    height: 320,
    radius: RADIUS,
    circles: [{ x: 190, y: 148 }],
    slots: {
      0b1: { x: 190, y: 148, width: 136, rows: 5 },
      0: { x: 318, y: 278, width: 106, rows: 3 },
    },
  },
  2: {
    width: WIDTH,
    height: 320,
    radius: RADIUS,
    circles: [
      { x: 135, y: 148 },
      { x: 245, y: 148 },
    ],
    slots: {
      0b01: { x: 104, y: 148, width: 76, rows: 5 },
      0b10: { x: 276, y: 148, width: 76, rows: 5 },
      0b11: { x: 190, y: 148, width: 53, rows: 3 },
      0: { x: 318, y: 288, width: 106, rows: 2 },
    },
  },
  3: {
    width: WIDTH,
    height: 410,
    radius: RADIUS,
    circles: [
      { x: 138, y: 148 },
      { x: 242, y: 148 },
      { x: 190, y: 238 },
    ],
    slots: {
      0b001: { x: 100, y: 116, width: 76, rows: 2 },
      0b010: { x: 280, y: 116, width: 76, rows: 2 },
      0b100: { x: 190, y: 280, width: 124, rows: 2 },
      0b011: { x: 190, y: 116, width: 64, rows: 1 },
      0b101: { x: 124, y: 220, width: 53, rows: 1 },
      0b110: { x: 256, y: 220, width: 53, rows: 1 },
      0b111: { x: 190, y: 172, width: 53, rows: 2 },
      0: { x: 318, y: 366, width: 106, rows: 3 },
    },
  },
};

/** The narrowest the diagram is drawn at (a 320px screen), and its text there, which set how much fits in a slot. */
const NARROW_SCALE = 230 / WIDTH;
const CHAR_PX = 7.2;
const ROW_PX = 16;
export const ROW_HEIGHT = ROW_PX / NARROW_SCALE;

/** How many characters of contents are sure to fit in a slot, at any size the diagram is drawn. */
export function slotCapacity(slot: RegionSlot): number {
  return Math.floor((slot.width * NARROW_SCALE) / CHAR_PX) * slot.rows;
}

export function regionMasks(setCount: number): number[] {
  return Array.from({ length: 2 ** setCount }, (_, mask) => mask);
}

export function isInRegion(layout: VennLayout, mask: number, p: Point): boolean {
  return layout.circles.every((c, i) => Math.hypot(p.x - c.x, p.y - c.y) < layout.radius === Boolean(mask & (1 << i)));
}

interface Arc {
  from: Point;
  to: Point;
  large: boolean;
  /** SVG's sweep flag: 1 runs in the direction of increasing angle. */
  sweep: 0 | 1;
}

/** The arcs of the circles that border a region, in no particular order. */
function borderArcs({ circles, radius }: VennLayout, mask: number): Arc[] {
  const arcs: Arc[] = [];
  circles.forEach((c, i) => {
    const at = (angle: number): Point => ({ x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) });
    const crossings = circles.flatMap((other, j) => {
      if (j === i) return [];
      const towards = Math.atan2(other.y - c.y, other.x - c.x);
      const spread = Math.acos(Math.hypot(other.x - c.x, other.y - c.y) / (2 * radius));
      return [towards - spread, towards + spread];
    });
    const angles = (crossings.length ? crossings : [0, Math.PI]).map((a) => (a + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
    angles.forEach((start, k) => {
      const end = k + 1 < angles.length ? angles[k + 1]! : angles[0]! + 2 * Math.PI;
      const middle = at((start + end) / 2);
      // A piece of this circle borders the region when it lies on the region's side of every other circle.
      const borders = circles.every((other, j) => j === i || Math.hypot(middle.x - other.x, middle.y - other.y) < radius === Boolean(mask & (1 << j)));
      if (!borders) return;
      const large = end - start > Math.PI;
      arcs.push(mask & (1 << i) ? { from: at(start), to: at(end), large, sweep: 1 } : { from: at(end), to: at(start), large, sweep: 0 });
    });
  });
  return arcs;
}

const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
const num = (n: number) => String(Math.round(n * 100) / 100);

/** The region as SVG path data, to be drawn with `fill-rule: evenodd`. The outside region is the frame with holes in it. */
export function regionPath(layout: VennLayout, mask: number): string {
  const { radius, width, height } = layout;
  const left = borderArcs(layout, mask);
  const loops: string[] = [];
  while (left.length) {
    const first = left.shift()!;
    let loop = `M${num(first.from.x)} ${num(first.from.y)}`;
    let arc: Arc | undefined = first;
    while (arc) {
      const { to, large, sweep } = arc;
      loop += `A${radius} ${radius} 0 ${large ? 1 : 0} ${sweep} ${num(to.x)} ${num(to.y)}`;
      const next = left.findIndex((candidate) => near(candidate.from, to));
      arc = next >= 0 ? left.splice(next, 1)[0] : undefined;
    }
    loops.push(`${loop}Z`);
  }
  if (mask === 0) loops.unshift(frame(width, height));
  return loops.join("");
}

export const FRAME_INSET = 1;
const frame = (width: number, height: number) => `M${FRAME_INSET} ${FRAME_INSET}H${width - FRAME_INSET}V${height - FRAME_INSET}H${FRAME_INSET}Z`;
