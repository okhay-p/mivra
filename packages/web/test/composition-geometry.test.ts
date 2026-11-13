import { describe, expect, it } from "vitest";
import { MIN_CONNECTOR_WIDTH, routeConnectors, type Box, type Point } from "../src/artifacts/composition-geometry.js";

// Two columns of 220px cards, 32px apart (the groups' padding and the gap), like the grid at about 700px.
const col = (i: number) => 10 + i * 252;
const card = (column: number, row: number, height = 60): Box => ({ x: col(column), y: 40 + row * 70, width: 220, height });
const W = 700;
const H = 400;

/** Whether a segment of the route passes through the box, touching allowed. */
const through = (points: Point[], box: Box) =>
  points.slice(1).some((b, i) => {
    const a = points[i]!;
    const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return x2 > box.x && x1 < box.x + box.width && y2 > box.y && y1 < box.y + box.height;
  });

describe("routeConnectors", () => {
  it("runs a line between side-by-side cards through the gutter, from the source's side to the target's", () => {
    const cards = new Map([["a", card(0, 0)], ["list", card(1, 1)]]);
    const { narrow, connectors } = routeConnectors(W, H, cards, [], [{ id: "a_list", from: "a", to: "list" }]);
    expect(narrow).toBe(false);
    expect(connectors).toHaveLength(1);
    const { points, path, arrow } = connectors[0]!;
    expect(points[0]).toMatchObject({ x: col(0) + 220 });
    expect(points.at(-1)).toMatchObject({ x: col(1) });
    // The tip is on the target's left edge, inside its height, and the arrowhead points right.
    const tip = points.at(-1)!;
    expect(tip.y).toBeGreaterThan(cards.get("list")!.y);
    expect(tip.y).toBeLessThan(cards.get("list")!.y + 60);
    expect(arrow.split(" ")[0]).toBe(`${tip.x},${tip.y}`);
    expect(path.startsWith(`M${col(0) + 220} `)).toBe(true);
    // The vertical run is in the gutter, clear of both cards.
    expect(points[1]!.x).toBeGreaterThan(col(0) + 220);
    expect(points[1]!.x).toBeLessThan(col(1));
  });

  it("runs a line right to left as well, entering the target's right side", () => {
    const cards = new Map([["b", card(1, 0)], ["a", card(0, 2)]]);
    const [line] = routeConnectors(W, H, cards, [], [{ id: "x", from: "b", to: "a" }]).connectors;
    expect(line!.points[0]!.x).toBe(col(1));
    expect(line!.points.at(-1)!.x).toBe(col(0) + 220);
  });

  it("runs a line between cards in one column down their right margin", () => {
    const cards = new Map([["top", card(0, 0)], ["middle", card(0, 1)], ["bottom", card(0, 2)]]);
    const [line] = routeConnectors(W, H, cards, [], [{ id: "x", from: "top", to: "bottom" }]).connectors;
    expect(line).toBeDefined();
    const margin = line!.points[1]!.x;
    expect(margin).toBeGreaterThan(col(0) + 220);
    // It passes the middle card without crossing it.
    expect(through(line!.points, cards.get("middle")!)).toBe(false);
    expect(line!.points.at(-1)!.x).toBe(col(0) + 220);
  });

  it("keeps parallel connections apart: separate lanes and separate ends", () => {
    const cards = new Map([["owner", card(0, 0)], ["record", card(1, 0)]]);
    const { connectors } = routeConnectors(W, H, cards, [], [
      { id: "owns", from: "owner", to: "record" },
      { id: "edits", from: "owner", to: "record" },
    ]);
    expect(connectors.map((c) => c.id)).toEqual(["owns", "edits"]);
    const [a, b] = connectors;
    expect(a!.points[1]!.x).not.toBe(b!.points[1]!.x);
    expect(a!.points[0]!.y).not.toBe(b!.points[0]!.y);
    expect(a!.points.at(-1)!.y).not.toBe(b!.points.at(-1)!.y);
    expect(a!.path).not.toBe(b!.path);
  });

  it("draws nothing it would have to route through another card, and leaves that one to its chip", () => {
    // Three columns: a line from the first to the third would cross the card in the middle.
    const third = { x: 10 + 2 * 252, y: 40, width: 220, height: 60 };
    const cards = new Map([["a", card(0, 0)], ["b", card(1, 0)], ["c", third]]);
    const { connectors } = routeConnectors(800, H, cards, [], [
      { id: "far", from: "a", to: "c" },
      { id: "near", from: "a", to: "b" },
    ]);
    expect(connectors.map((c) => c.id)).toEqual(["near"]);
  });

  it("never crosses an obstacle such as a group heading", () => {
    const cards = new Map([["top", card(0, 0)], ["bottom", card(0, 3)]]);
    // A heading that reaches into the right margin, between the two cards.
    const heading = { x: col(0), y: 150, width: 240, height: 16 };
    expect(routeConnectors(W, H, cards, [heading], [{ id: "x", from: "top", to: "bottom" }]).connectors).toEqual([]);
    expect(routeConnectors(W, H, cards, [{ ...heading, width: 220 }], [{ id: "x", from: "top", to: "bottom" }]).connectors).toHaveLength(1);
  });

  it("gives up on lines that no longer fit in a gutter, rather than squeezing them against a card", () => {
    const cards = new Map([["a", card(0, 0, 200)], ["b", card(1, 0, 200)]]);
    const requests = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, from: "a", to: "b" }));
    const { connectors } = routeConnectors(W, H, cards, [], requests);
    expect(connectors.length).toBeGreaterThan(1);
    expect(connectors.length).toBeLessThan(6);
    for (const connector of connectors) {
      const x = connector.points[1]!.x;
      expect(x - (col(0) + 220)).toBeGreaterThanOrEqual(6);
      expect(col(1) - x).toBeGreaterThanOrEqual(6);
    }
  });

  it("draws no lines in one narrow column: chips carry every reference there", () => {
    const cards = new Map([["a", { x: 0, y: 0, width: 300, height: 50 }], ["b", { x: 0, y: 80, width: 300, height: 50 }]]);
    expect(routeConnectors(MIN_CONNECTOR_WIDTH - 1, H, cards, [], [{ id: "x", from: "a", to: "b" }])).toEqual({ narrow: true, connectors: [] });
  });

  it("skips connections whose cards weren't measured, as before layout or in jsdom", () => {
    const cards = new Map([["a", card(0, 0)], ["b", { x: 0, y: 0, width: 0, height: 0 }]]);
    expect(routeConnectors(W, H, cards, [], [{ id: "x", from: "a", to: "b" }, { id: "y", from: "a", to: "gone" }]).connectors).toEqual([]);
  });

  it("keeps every line out of the cards it doesn't join, across a busy two-column layout", () => {
    const cards = new Map([
      ["a", card(0, 0)],
      ["b", card(0, 1)],
      ["c", card(0, 2)],
      ["d", card(1, 0)],
      ["e", card(1, 1)],
      ["f", card(1, 2)],
    ]);
    const requests = [
      { id: "1", from: "a", to: "f" },
      { id: "2", from: "c", to: "d" },
      { id: "3", from: "a", to: "c" },
      { id: "4", from: "e", to: "b" },
      { id: "5", from: "d", to: "f" },
      { id: "6", from: "b", to: "e" },
    ];
    const { connectors } = routeConnectors(W, H, cards, [], requests);
    expect(connectors.length).toBeGreaterThanOrEqual(4);
    for (const connector of connectors) {
      const { from, to } = requests.find((r) => r.id === connector.id)!;
      for (const [id, box] of cards) if (id !== from && id !== to) expect(through(connector.points, box), `${connector.id} crosses ${id}`).toBe(false);
    }
  });
});
