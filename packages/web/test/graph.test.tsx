import type { GraphSpec } from "@mivra/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactPart } from "../src/artifacts/ArtifactPart.js";
import { graphStateAt } from "../src/artifacts/Graph.js";
import { layoutGraph } from "../src/artifacts/graph-layout.js";
import { graph } from "./fixtures.js";

const renderGraph = (data: unknown = graph) => render(<ArtifactPart data={data} replyInProgress={false} onUpdate={() => {}} onRefresh={async () => {}} />);
const next = () => fireEvent.click(screen.getByRole("button", { name: /next/i }));
const tones = (testId: string) => screen.getAllByTestId(testId).map((e) => e.getAttribute("data-tone"));
const description = () => screen.getByTestId("graph-description").textContent;
const status = () => screen.getByTestId("graph-status");

const nodes = (...ids: string[]) => ids.map((id) => ({ id }));
const edges = (...pairs: [string, string][]) => pairs.map(([from, to]) => ({ from, to }));
const base = { directed: false, nodes: nodes("a", "b", "c", "d"), edges: [] };

describe("Graph", () => {
  it("draws every node and edge, with arrowheads only when directed", () => {
    renderGraph();
    expect(screen.getAllByTestId("graph-node")).toHaveLength(3);
    expect(screen.getAllByTestId("graph-edge")).toHaveLength(3);
    expect(screen.getAllByTestId("graph-arrow")).toHaveLength(3);
    expect(screen.getAllByTestId("graph-edge-label").map((e) => e.textContent)).toEqual(["4", "1", "go"]);
  });

  it("omits arrowheads on an undirected graph, and the stepper when there are no steps", () => {
    renderGraph({ ...graph, spec: { title: "Plain", directed: false, nodes: nodes("a", "b"), edges: edges(["a", "b"]) } });
    expect(screen.queryAllByTestId("graph-arrow")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
    expect(screen.queryByText(/^Step /)).toBeNull();
  });

  it("applies node and edge state to its own step only", () => {
    renderGraph();
    expect(tones("graph-node")).toEqual(["active", null, null]);
    expect(tones("graph-edge")).toEqual(["active", "muted", null]);
    expect(screen.getByText("dist")).toBeTruthy();

    next();
    expect(tones("graph-node")).toEqual(["done", "active", null]);
    expect(tones("graph-edge")).toEqual([null, null, "done"]);
    expect(screen.queryByText("dist")).toBeNull();

    next();
    expect(tones("graph-node")).toEqual([null, null, null]);
    expect(tones("graph-edge")).toEqual([null, null, null]);
  });

  it("resolves a parallel edge's nth, in either order when undirected", () => {
    const spec: GraphSpec = {
      title: "Parallel",
      directed: false,
      nodes: nodes("a", "b"),
      edges: edges(["a", "b"], ["b", "a"]),
      steps: [{ explanation: "x", edgeStates: [{ from: "b", to: "a", nth: 1, tone: "done" }] }],
    };
    expect([...graphStateAt(spec, 0).edges]).toEqual([[1, "done"]]);
  });

  it("describes the graph and the current step in words", () => {
    renderGraph();
    expect(description()).toContain("Directed graph with 3 nodes and 3 edges.");
    expect(description()).toContain("Edge: start to b, weight 4");
    expect(description()).toContain("Edge: start to itself");
    expect(description()).toContain("Edge: b to c, labelled");
    expect(status().textContent).toContain("Node start is active");
    expect(status().textContent).toContain("Edge start to b, weight 4 is active");
    expect(status().textContent).toContain("dist = 0");
    next();
    expect(status().textContent).toContain("Node start is done");
    expect(status().textContent).not.toContain("is ruled out");
  });

  it("announces a step atomically from one live region, even when its explanation repeats", () => {
    const same = "Look at the next node.";
    renderGraph({
      ...graph,
      spec: { title: "Same", directed: false, nodes: nodes("a", "b"), edges: [], steps: [{ explanation: same, nodeStates: [{ id: "a" }] }, { explanation: same, nodeStates: [{ id: "b" }] }] },
    });
    const live = status();
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-atomic")).toBe("true");
    expect(live.textContent).toContain("Step 1 of 2.");
    expect(live.textContent).toContain("Node a is active");
    next();
    expect(status()).toBe(live);
    expect(live.textContent).toContain("Step 2 of 2.");
    expect(live.textContent).toContain(same);
    expect(live.textContent).toContain("Node b is active");
    expect(live.textContent).not.toContain("Node a");
    // The visible copies would otherwise be read twice.
    expect(screen.getByTestId("graph-explanation").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Step 2 of 2").getAttribute("aria-hidden")).toBe("true");
  });

  it("says which child an edge is", () => {
    renderGraph({ ...graph, spec: { title: "T", directed: true, kind: "tree", nodes: nodes("r", "x"), edges: [{ from: "r", to: "x", side: "right" }] } });
    expect(description()).toContain("Edge: r to x, right child");
  });

  it("names the card by its rendered heading, not the title's source", () => {
    renderGraph({ ...graph, spec: { ...graph.spec, title: "Walk $v_1$" } });
    const region = screen.getByRole("region", { name: /Directed graph$/ });
    expect(region.getAttribute("aria-label")).toBeNull();
    const [title] = region.getAttribute("aria-labelledby")!.split(" ");
    expect(document.getElementById(title!)!.tagName).toBe("H3");
    expect(document.getElementById(title!)!.querySelector(".katex")).toBeTruthy();
  });

  it("makes the scrolling box a named tab stop only when it overflows, and leaves its arrow keys alone", () => {
    renderGraph();
    const box = screen.getByTestId("graph-scroll");
    expect(box.getAttribute("tabindex")).toBeNull();
    expect(box.getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByTestId("graph-canvas").getAttribute("aria-hidden")).toBe("true");
    cleanup();

    const wide = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(500);
    renderGraph();
    const scroller = screen.getByRole("group", { name: "Scrollable graph drawing" });
    expect(scroller.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(scroller, { key: "ArrowRight" });
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowRight" });
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    wide.mockRestore();
  });

  it("says undirected edges have no direction, and that muted means ruled out", () => {
    renderGraph({
      ...graph,
      spec: { title: "U", directed: false, nodes: nodes("a", "b"), edges: edges(["a", "b"]), steps: [{ explanation: "x", edgeStates: [{ from: "a", to: "b", tone: "muted" }] }] },
    });
    expect(description()).toContain("Undirected graph with 2 nodes and 1 edge.");
    expect(description()).toContain("Edge: a and b");
    expect(status().textContent).toContain("Edge a and b is ruled out");
  });

  it("steps with the arrow keys and plays to the end", () => {
    vi.useFakeTimers();
    renderGraph();
    const region = screen.getByRole("region", { name: /Walk/ });
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    for (let i = 0; i < 5; i++) act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a node where it is while stepping", () => {
    renderGraph();
    const places = () => screen.getAllByTestId("graph-node").map((e) => [e.style.left, e.style.top]);
    const paths = () => screen.getAllByTestId("graph-edge").map((e) => e.querySelector("path")!.getAttribute("d"));
    const before = [places(), paths()];
    next();
    next();
    expect([places(), paths()]).toEqual(before);
  });

  it("puts a formula in a node label through KaTeX, and keeps other text literal", () => {
    renderGraph({ ...graph, spec: { title: "T", directed: false, nodes: [{ id: "a", label: "$v_1$" }, { id: "b", label: "2*3*4" }], edges: [] } });
    const [a, b] = screen.getAllByTestId("graph-node");
    expect(a!.querySelector(".katex")).toBeTruthy();
    expect(b!.textContent).toBe("2*3*4");
  });
});

describe("layoutGraph", () => {
  const dense: GraphSpec = {
    title: "Limit",
    directed: true,
    nodes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}` })),
    edges: Array.from({ length: 200 }, (_, i) => ({ from: `n${i % 60}`, to: `n${(i * 7 + 11) % 60}`, weight: i })),
  };

  it("gives the same coordinates for the same spec", () => {
    expect(layoutGraph(dense)).toEqual(layoutGraph(structuredClone(dense)));
    expect(layoutGraph(base)).toEqual(layoutGraph(base));
  });

  it("ignores steps", () => {
    const stepped: GraphSpec = { ...base, title: "x", steps: [{ explanation: "x", nodeStates: [{ id: "a" }] }] };
    expect(layoutGraph(stepped)).toEqual(layoutGraph(base));
  });

  // A guard against something going badly wrong, not a benchmark: this runs on busy machines.
  it("is fast enough to run synchronously at the limits", () => {
    const start = performance.now();
    layoutGraph(dense);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("puts everything inside the box, with nodes apart", () => {
    const layout = layoutGraph(dense);
    for (const node of layout.nodes) {
      expect(node.x - node.width / 2).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width / 2).toBeLessThanOrEqual(layout.width);
      expect(node.y - node.height / 2).toBeGreaterThanOrEqual(0);
      expect(node.y + node.height / 2).toBeLessThanOrEqual(layout.height);
    }
    expect(new Set(layout.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(60);
  });

  it("uses the tree layout for a real tree, in levels, with children in edge order", () => {
    const layout = layoutGraph({ directed: true, kind: "tree", nodes: nodes("r", "x", "y", "z"), edges: edges(["r", "x"], ["r", "y"], ["x", "z"]) });
    expect(layout.mode).toBe("tree");
    const [r, x, y, z] = layout.nodes;
    expect(x!.y).toBeGreaterThan(r!.y);
    expect(x!.y).toBe(y!.y);
    expect(x!.x).toBeLessThan(y!.x);
    expect(z!.y).toBeGreaterThan(x!.y);
  });

  describe("binary tree sides", () => {
    const tree = (...sided: [string, string, "left" | "right"][]) => ({
      directed: true,
      kind: "tree" as const,
      nodes: nodes(...new Set(sided.flatMap(([from, to]) => [from, to]))),
      edges: sided.map(([from, to, side]) => ({ from, to, side })),
    });
    const at = (layout: ReturnType<typeof layoutGraph>, id: string) => layout.nodes.find((n) => n.id === id)!;
    /** Inorder is left to right on the page, with no ties, which is what a BST's drawing should show. */
    const expectInorder = (layout: ReturnType<typeof layoutGraph>, inorder: string[]) => {
      const xs = inorder.map((id) => at(layout, id).x);
      xs.slice(1).forEach((x, i) => expect(x, `${inorder[i]} before ${inorder[i + 1]}`).toBeGreaterThan(xs[i]!));
    };
    const expectParentsAbove = (layout: ReturnType<typeof layoutGraph>, spec: { edges: { from: string; to: string }[] }) => {
      for (const { from, to } of spec.edges) expect(at(layout, from).y, `${from} above ${to}`).toBeLessThan(at(layout, to).y);
    };
    const chain = (side: "left" | "right", count: number): [string, string, "left" | "right"][] =>
      Array.from({ length: count - 1 }, (_, i) => [String(i), String(i + 1), side]);
    const ids = (count: number) => Array.from({ length: count }, (_, i) => String(i));

    const shapes: [string, [string, string, "left" | "right"][], string[]][] = [
      [
        "a left subtree that runs right, under a root",
        [["10", "5", "left"], ["10", "20", "right"], ["5", "6", "right"], ["6", "7", "right"], ["7", "8", "right"]],
        ["5", "6", "7", "8", "10", "20"],
      ],
      [
        "its mirror",
        [["10", "20", "right"], ["10", "5", "left"], ["20", "19", "left"], ["19", "18", "left"], ["18", "17", "left"]],
        ["5", "10", "17", "18", "19", "20"],
      ],
      ["a left-only chain", chain("left", 8), ids(8).reverse()],
      ["a right-only chain", chain("right", 8), ids(8)],
      [
        "a balanced BST",
        [["4", "2", "left"], ["4", "6", "right"], ["2", "1", "left"], ["2", "3", "right"], ["6", "5", "left"], ["6", "7", "right"]],
        ["1", "2", "3", "4", "5", "6", "7"],
      ],
    ];
    it.each(shapes)("draws inorder strictly left to right, parents above children: %s", (_, sided, inorder) => {
      const spec = tree(...sided);
      const layout = layoutGraph(spec);
      expect(layout.mode).toBe("tree");
      expectInorder(layout, inorder);
      expectParentsAbove(layout, spec);
      expect(layoutGraph(structuredClone(spec))).toEqual(layout);
    });

    it("keeps nodes on one level apart, and two siblings' weights from touching, however wide", () => {
      const spec = tree(["root", "a-very-long-node-name", "left"], ["root", "another-long-name", "right"]);
      const wide = layoutGraph(spec);
      const [, left, right] = wide.nodes;
      expect(right!.x - right!.width / 2).toBeGreaterThan(left!.x + left!.width / 2);

      const weighted = { ...tree(["p", "l", "left"], ["p", "r", "right"]) };
      weighted.edges = weighted.edges.map((edge) => ({ ...edge, weight: 123456789 }));
      const [a, b] = layoutGraph(weighted).edges;
      expect(b!.label.y).toBe(a!.label.y);
      expect(b!.label.x - a!.label.x).toBeGreaterThan(9 * 13 * 0.6 + 8);
    });

    it("keeps sides honest in a tree that only uses them on some nodes", () => {
      // The schema allows this: each node's children either all have a side or none do.
      const spec = {
        directed: true,
        kind: "tree" as const,
        nodes: nodes("r", "a", "b", "c", "a1", "a2", "a3", "c1"),
        edges: [
          { from: "r", to: "a", side: "left" as const },
          { from: "r", to: "b", side: "right" as const },
          // a's children have no side, so they stay in edge order, on the left of r.
          { from: "a", to: "a1" },
          { from: "a", to: "a2" },
          { from: "a", to: "a3" },
          // b has one child with no side, and it has a sided child.
          { from: "b", to: "c" },
          { from: "c", to: "c1", side: "left" as const },
        ],
      };
      const layout = layoutGraph(spec);
      const x = (id: string) => at(layout, id).x;
      expect(layout.mode).toBe("tree");
      expectParentsAbove(layout, spec);
      expectInorder(layout, ["a1", "a2", "a3", "r", "c1", "c"]);
      expect(x("a")).toBe(x("a2"));
      expect(x("b")).toBe(x("c"));
      expect(x("b")).toBeGreaterThan(x("r"));
      const box = (id: string) => at(layout, id);
      for (const [one, other] of [["a1", "a2"], ["a2", "a3"]]) expect(box(other!).x - box(other!).width / 2).toBeGreaterThan(box(one!).x + box(one!).width / 2);
    });

    it("keeps an all-unsided tree in its tidy layout", () => {
      const unsided = layoutGraph({ directed: true, kind: "tree", nodes: nodes("r", "x", "y", "z"), edges: edges(["r", "x"], ["r", "y"], ["x", "z"]) });
      const [r, x, y, z] = unsided.nodes;
      expect(r!.x).toBe((x!.x + y!.x) / 2);
      // Under its parent, which inorder columns wouldn't put it.
      expect(z!.x).toBe(x!.x);
    });

    it("puts a lone child on its own side of its parent", () => {
      const left = layoutGraph(tree(["p", "c", "left"]));
      const right = layoutGraph(tree(["p", "c", "right"]));
      expect(left.mode).toBe("tree");
      expect(at(left, "c").x).toBeLessThan(at(left, "p").x);
      expect(at(right, "c").x).toBeGreaterThan(at(right, "p").x);
      expect(at(left, "c").y).toBeGreaterThan(at(left, "p").y);
    });

    it("draws a real BST by side, whatever order the edges come in", () => {
      // 8 has both, 3 has both, 10 has only a right child and 14 only a left one.
      const layout = layoutGraph(tree(["8", "10", "right"], ["8", "3", "left"], ["3", "6", "right"], ["3", "1", "left"], ["10", "14", "right"], ["14", "13", "left"]));
      const x = (id: string) => at(layout, id).x;
      for (const [parent, child] of [["8", "3"], ["3", "1"], ["14", "13"]]) expect(x(child!)).toBeLessThan(x(parent!));
      for (const [parent, child] of [["8", "10"], ["3", "6"], ["10", "14"]]) expect(x(child!)).toBeGreaterThan(x(parent!));
      expectInorder(layout, ["1", "3", "6", "8", "10", "13", "14"]);
      expect(layoutGraph(structuredClone(tree(["8", "3", "left"])))).toEqual(layoutGraph(tree(["8", "3", "left"])));
    });

    it("leaves unsided children in edge order, centred when alone", () => {
      const layout = layoutGraph({ directed: true, kind: "tree", nodes: nodes("p", "c"), edges: edges(["p", "c"]) });
      expect(at(layout, "c").x).toBe(at(layout, "p").x);
    });

    it("spreads a deep skewed tree out, with nodes apart and nothing overlapping", () => {
      const layout = layoutGraph(tree(...chain("left", 60)));
      expect(layout.width).toBeGreaterThan(1000);
      expect(layout.height).toBeGreaterThan(4000);
      for (let i = 1; i < 60; i++) {
        expect(layout.nodes[i]!.x).toBeLessThan(layout.nodes[i - 1]!.x);
        expect(layout.nodes[i]!.y).toBeGreaterThan(layout.nodes[i - 1]!.y);
      }
    });
  });

  it("roots an undirected tree at its first node", () => {
    const layout = layoutGraph({ directed: false, kind: "tree", nodes: nodes("r", "x", "y"), edges: edges(["x", "r"], ["y", "x"]) });
    expect(layout.mode).toBe("tree");
    const [r, x, y] = layout.nodes;
    expect(r!.y).toBeLessThan(x!.y);
    expect(x!.y).toBeLessThan(y!.y);
  });

  it("falls back to the general layout for anything that isn't a real tree", () => {
    const fallback: [string, Parameters<typeof layoutGraph>[0]][] = [
      ["cycle", { directed: false, kind: "tree", nodes: nodes("a", "b", "c"), edges: edges(["a", "b"], ["b", "c"], ["c", "a"]) }],
      ["disconnected, right edge count", { directed: false, kind: "tree", nodes: nodes("a", "b", "c", "d"), edges: edges(["a", "b"], ["c", "d"], ["d", "c"]) }],
      ["two roots", { directed: true, kind: "tree", nodes: nodes("a", "b", "c"), edges: edges(["a", "c"], ["b", "c"]) }],
      ["no root", { directed: true, kind: "tree", nodes: nodes("a", "b"), edges: edges(["a", "b"], ["b", "a"]) }],
      ["self-loop", { directed: false, kind: "tree", nodes: nodes("a", "b"), edges: edges(["a", "a"]) }],
      ["parallel edge", { directed: false, kind: "tree", nodes: nodes("a", "b", "c"), edges: edges(["a", "b"], ["a", "b"]) }],
      ["directed loop hidden by a root", { directed: true, kind: "tree", nodes: nodes("r", "a", "b", "c"), edges: edges(["r", "c"], ["a", "b"], ["b", "a"]) }],
    ];
    for (const [name, spec] of fallback) expect(layoutGraph(spec).mode, name).toBe("general");
    expect(layoutGraph({ directed: true, nodes: nodes("a", "b"), edges: edges(["a", "b"]) }).mode).toBe("general");
  });

  it("gives parallel and opposite edges and repeated loops separate paths, with arrowheads", () => {
    const layout = layoutGraph({ directed: true, nodes: nodes("a", "b"), edges: edges(["a", "b"], ["b", "a"], ["a", "b"], ["a", "a"], ["a", "a"]) });
    expect(new Set(layout.edges.map((e) => e.path)).size).toBe(5);
    expect(layout.edges.every((e) => e.arrow)).toBe(true);
    expect(layout.edges.every((e) => !e.path.includes("NaN"))).toBe(true);
  });

  it("keeps a weight out from behind nodes and other labels when it can", () => {
    // The graph whose weight was once hidden behind an unrelated node.
    const spec = { directed: true, nodes: nodes("a", "b", "c", "d", "e"), edges: [["a", "b"], ["a", "c"], ["c", "b"], ["b", "c"], ["b", "d"], ["c", "d"], ["d", "e"]].map(([from, to], i) => ({ from: from!, to: to!, weight: i })) };
    const layout = layoutGraph(spec);
    const clear = (x: number, y: number, w: number, other: { x: number; y: number; width: number; height: number }) =>
      Math.abs(x - other.x) >= (w + other.width) / 2 || Math.abs(y - other.y) >= (18 + other.height) / 2;
    for (const edge of layout.edges) {
      for (const node of layout.nodes) expect(clear(edge.label.x, edge.label.y, 16, node)).toBe(true);
    }
  });

  it("copes with a single node", () => {
    const layout = layoutGraph({ directed: false, nodes: nodes("a"), edges: edges(["a", "a"]) });
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.edges[0]!.path).not.toContain("NaN");
  });
});
