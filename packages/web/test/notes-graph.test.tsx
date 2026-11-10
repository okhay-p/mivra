import type { NoteGraphView, NoteView, VaultImportView } from "@mivra/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { nodeInDirection, NotesGraph } from "../src/NotesGraph.js";
import { layoutNotesGraph } from "../src/notes-graph-layout.js";

vi.setConfig({ testTimeout: 20_000 });

// jsdom lacks what Radix's Select uses to open and scroll to its options.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const graphView = (over: Partial<NoteGraphView> = {}): NoteGraphView => ({
  mode: "whole",
  focus: null,
  depth: 2,
  totalNotes: 3,
  matchingNotes: 3,
  truncated: false,
  nodes: [
    { id: "a", kind: "note", label: "Recursion", path: "CS/Recursion.md" },
    { id: "b", kind: "note", label: "Stack", path: "CS/Stack.md" },
    { id: "c", kind: "note", label: "Bread", path: "Bread.md" },
    { id: "tag:cs", kind: "tag", label: "#cs", notes: 2 },
    { id: "concept:k", kind: "concept", label: "Call stack", notes: 1 },
    { id: "ghost:base case", kind: "ghost", label: "Base case" },
  ],
  edges: [
    { from: "a", to: "b", kind: "link" },
    { from: "a", to: "ghost:base case", kind: "link" },
    { from: "tag:cs", to: "a", kind: "tag" },
    { from: "tag:cs", to: "b", kind: "tag" },
    { from: "concept:k", to: "b", kind: "concept" },
  ],
  tags: [{ name: "cs", notes: 2 }],
  folders: [{ path: "CS", notes: 2 }],
  ...over,
});

const importView: VaultImportView = {
  id: "i1",
  name: "Vault",
  source: "obsidian",
  noteCount: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  distillation: { status: "idle", pendingNotes: 0, groups: 0, groupsDone: 0, error: null, concepts: 1, memories: 0 },
};
const note: NoteView = { id: "a", importId: "i1", path: "CS/Recursion.md", title: "Recursion", aliases: ["Self reference"], tags: ["cs"], body: "A function that <b>calls</b> itself.", updatedAt: "2026-11-01T00:00:00.000Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers the graph's requests by path, and records each graph view's query. */
function serve(views: (query: URLSearchParams) => NoteGraphView = () => graphView()) {
  const queries: URLSearchParams[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/imports") return json([importView]);
    if (url.pathname === "/api/imports/i1/graph/view") {
      queries.push(url.searchParams);
      return json(views(url.searchParams));
    }
    if (url.pathname === "/api/notes/a") return json(note);
    if (url.pathname === "/api/imports/i1/notes") return json([{ id: "b", title: "Stack", path: "CS/Stack.md" }]);
    return json({ error: "nope" }, 404);
  });
  return queries;
}

const status = () => screen.getByTestId("notes-graph-status");

describe("notes graph", () => {
  it("draws the view with a named button per node and says what it shows", async () => {
    serve();
    render(<NotesGraph importId="i1" />);
    await waitFor(() => expect(status().textContent).toContain("Whole graph: 3 notes, 1 tag, 1 concept, 1 unresolved link, of 3 notes."));
    const group = screen.getByRole("group", { name: /^Notes graph/ });
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(6);
    expect(within(group).getByRole("button", { name: "Recursion, note in CS/Recursion.md, 3 connections" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "#cs, tag on 2 notes" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Call stack, concept from 1 note" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Base case, unresolved link, no such note" })).toBeTruthy();
    // One tab stop for the whole drawing.
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    // The SVG holds the edges and shapes and is hidden from screen readers; labels are HTML over it.
    expect(screen.getAllByTestId("notes-graph-edge")).toHaveLength(5);
    expect(screen.getAllByTestId("notes-graph-label").map((l) => l.textContent)).toContain("#cs");
  });

  it("moves between nodes with the arrow keys and announces what each connects to", async () => {
    serve();
    render(<NotesGraph importId="i1" />);
    const first = await screen.findByRole("button", { name: /^Recursion, note/ });
    act(() => first.focus());
    expect(screen.getByTestId("notes-graph-neighbours").textContent).toMatch(/^Recursion connects to (Stack|#cs|Base case \(unresolved\)), /);
    const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"];
    const moved = keys.some((key) => {
      fireEvent.keyDown(document.activeElement!, { key });
      return document.activeElement !== first;
    });
    expect(moved).toBe(true);
    expect(document.activeElement!.getAttribute("data-testid")).toBe("notes-graph-node");
    expect(document.activeElement!.getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("tabindex")).toBe("-1");
  });

  it("opens a clicked note to read, as plain text, and recentres the graph on it", async () => {
    const queries = serve();
    render(<NotesGraph importId="i1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Recursion, note/ }));
    const reader = await screen.findByRole("dialog", { name: "Recursion" });
    await waitFor(() => expect(within(reader).getByTestId("note-body").textContent).toContain("A function that <b>calls</b> itself."));
    expect(within(reader).queryByText("calls", { selector: "b" })).toBeNull();
    expect(within(reader).getByText("CS/Recursion.md · read-only")).toBeTruthy();
    expect(within(reader).getByText("#cs")).toBeTruthy();
    expect(within(reader).getByText("Also called Self reference")).toBeTruthy();
    // Behind the modal reader, so hidden from the accessibility tree for now.
    expect(screen.getByRole("button", { name: /^Recursion, note/, hidden: true }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(reader).getByRole("button", { name: "Show the graph around this note" }));
    await waitFor(() => expect(queries.at(-1)?.get("focus")).toBe("a"));
    expect(queries.at(-1)?.get("mode")).toBe("local");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Recursion" })).toBeNull());
  });

  it("asks the server again when a filter changes", async () => {
    const queries = serve();
    render(<NotesGraph importId="i1" />);
    await waitFor(() => expect(status().textContent).toMatch(/^Whole graph/));
    const tag = screen.getByRole("combobox", { name: "Tag" });
    fireEvent.keyDown(tag, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "#cs (2)" }));
    await waitFor(() => expect(queries.at(-1)?.get("tag")).toBe("cs"));
    expect(queries.at(-1)?.get("depth")).toBe("2");
    expect(queries[0]!.has("tag")).toBe(false);
  });

  it("opens a large import on the local graph, and doesn't offer the whole graph", async () => {
    serve(() => graphView({ mode: "local", focus: "a", totalNotes: 2_000, matchingNotes: 2_000, truncated: true, nodes: graphView().nodes.map((n) => (n.kind === "note" ? { ...n, hops: n.id === "a" ? 0 : 1 } : n)) }));
    render(<NotesGraph importId="i1" />);
    await waitFor(() =>
      expect(status().textContent).toContain("Around Recursion, within 2 hops: 3 notes, 1 tag, 1 concept, 1 unresolved link, of 2,000 notes. Only the nearest are drawn; filter or centre on a note to see others."),
    );
    expect(screen.getByRole("combobox", { name: "Reach" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Show" }), { key: "Enter" });
    expect((await screen.findByRole("option", { name: "Whole graph (over 500 notes)" })).getAttribute("aria-disabled")).toBe("true");
  });

  it("says when nothing matches, and shows the server's error", async () => {
    serve(() => graphView({ nodes: [], edges: [], matchingNotes: 0 }));
    const { unmount } = render(<NotesGraph importId="i1" />);
    await waitFor(() => expect(status().textContent).toContain("No note matches these filters."));
    unmount();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (String(input).includes("graph") ? json({ error: "Import not found" }, 404) : json([])));
    render(<NotesGraph importId="i1" />);
    await waitFor(() => expect(status().textContent).toContain("Import not found"));
  });
});

describe("notes graph layout", () => {
  it("is the same every time, keeps every node inside its box, and keeps nodes apart", () => {
    const view = graphView();
    const first = layoutNotesGraph(view);
    expect(layoutNotesGraph(view)).toEqual(first);
    for (const node of first.nodes) {
      expect(node.x - node.radius).toBeGreaterThanOrEqual(0);
      expect(node.y - node.radius).toBeGreaterThanOrEqual(0);
      expect(node.x + node.radius).toBeLessThanOrEqual(first.width);
      expect(node.y + node.radius).toBeLessThanOrEqual(first.height);
    }
    for (const a of first.nodes) for (const b of first.nodes) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.radius + b.radius);
    expect(first.edges).toHaveLength(view.edges.length);
  });

  it("lays out a thousand nodes", () => {
    const nodes = Array.from({ length: 1_000 }, (_, i) => ({ id: `n${i}`, kind: "note" as const, label: `Note ${i}`, path: `${i}.md` }));
    const edges = nodes.map((n, i) => ({ from: n.id, to: nodes[(i * 7 + 1) % nodes.length]!.id, kind: "link" as const }));
    const layout = layoutNotesGraph({ nodes, edges });
    expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("finds the next node in an arrow key's direction, preferring ones straight ahead", () => {
    const layout = {
      width: 300,
      height: 300,
      edges: [],
      nodes: [
        { id: "centre", x: 150, y: 150, radius: 5 },
        { id: "right", x: 250, y: 150, radius: 5 },
        { id: "near-diagonal", x: 200, y: 220, radius: 5 },
        { id: "up", x: 150, y: 40, radius: 5 },
      ],
    };
    expect(nodeInDirection(layout, 0, "ArrowRight")).toBe(1);
    expect(nodeInDirection(layout, 0, "ArrowUp")).toBe(3);
    expect(nodeInDirection(layout, 0, "ArrowDown")).toBe(2);
    expect(nodeInDirection(layout, 0, "ArrowLeft")).toBeUndefined();
    expect(nodeInDirection(layout, 0, "Enter")).toBeUndefined();
  });
});
