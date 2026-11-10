import {
  MAX_GRAPH_FACETS,
  MAX_GRAPH_VIEW_EDGES,
  MAX_GRAPH_VIEW_NODES,
  MAX_GRAPH_VIEW_NOTES,
  NoteGraphView,
  NoteGraphViewQuery,
  NoteSummary,
  WHOLE_GRAPH_NOTES,
  type ConceptGraph,
  type NoteGraph,
  type VaultFile,
} from "@mivra/protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { noteGraphView } from "../src/notes/graph-view.js";

type Note = NoteGraph["notes"][number];
const note = (id: string, tags: string[] = [], path = `${id}.md`): Note => ({ id, path, title: id, tags });
const link = (from: string, to: string | null, target = to ?? "missing"): NoteGraph["links"][number] => ({ from, to, target, kind: "link" });
const noConcepts: ConceptGraph = { concepts: [], edges: [] };
const view = (graph: NoteGraph, query: Partial<NoteGraphViewQuery> = {}, concepts = noConcepts) =>
  NoteGraphView.parse(noteGraphView(graph, concepts, NoteGraphViewQuery.parse(query)));
const ids = (v: NoteGraphView, kind?: string) => v.nodes.filter((n) => !kind || n.kind === kind).map((n) => n.id);

/** A chain a – b – c – d – e, each linking the next. */
const chain: NoteGraph = {
  notes: ["a", "b", "c", "d", "e"].map((id) => note(id)),
  links: [link("a", "b"), link("b", "c"), link("c", "d"), link("d", "e")],
};

describe("noteGraphView", () => {
  it("draws a small import whole, with unresolved links as one ghost per target", () => {
    const v = view({ notes: [note("a"), note("b")], links: [link("a", "b"), link("b", "a"), link("a", null, "Gone"), link("b", null, "gone ")] });
    expect(v.mode).toBe("whole");
    expect(v.focus).toBeNull();
    expect(ids(v, "note")).toEqual(["a", "b"]);
    expect(v.nodes.find((n) => n.kind === "ghost")).toEqual({ id: "ghost:gone", kind: "ghost", label: "Gone" });
    // A link both ways is one edge; both notes link the ghost.
    expect(v.edges).toEqual([
      { from: "a", to: "b", kind: "link" },
      { from: "a", to: "ghost:gone", kind: "link" },
      { from: "b", to: "ghost:gone", kind: "link" },
    ]);
  });

  it("makes tags and concepts nodes connecting the notes that carry or cover them, with concept edges", () => {
    const concepts: ConceptGraph = {
      concepts: [
        { id: "k1", name: "Recursion", notes: ["a", "b", "elsewhere"] },
        { id: "k2", name: "Stack", notes: ["c"] },
        { id: "k3", name: "Only elsewhere", notes: ["elsewhere"] },
      ],
      edges: [{ from: "k2", to: "k1", kind: "prerequisite", notes: ["c"] }],
    };
    const v = view({ notes: [note("a", ["cs"]), note("b", ["cs"]), note("c")], links: [] }, {}, concepts);
    expect(v.nodes.filter((n) => n.kind !== "note")).toEqual([
      { id: "concept:k1", kind: "concept", label: "Recursion", notes: 2 },
      { id: "tag:cs", kind: "tag", label: "#cs", notes: 2 },
      { id: "concept:k2", kind: "concept", label: "Stack", notes: 1 },
    ]);
    expect(v.edges).toEqual([
      { from: "concept:k2", to: "concept:k1", kind: "prerequisite" },
      { from: "concept:k1", to: "a", kind: "concept" },
      { from: "concept:k1", to: "b", kind: "concept" },
      { from: "concept:k2", to: "c", kind: "concept" },
      { from: "tag:cs", to: "a", kind: "tag" },
      { from: "tag:cs", to: "b", kind: "tag" },
    ]);
  });

  it("filters by tag, including nested tags, and by folder, and lists both for the filters", () => {
    const graph: NoteGraph = {
      notes: [note("a", ["maths"], "Maths/a.md"), note("b", ["maths/algebra"], "Maths/Algebra/b.md"), note("c", ["mathsy"], "c.md"), note("d", [], "Maths/d.md")],
      links: [link("a", "c"), link("a", "d")],
    };
    // Path order, by code point: "Maths/Algebra/…" before "Maths/a.md".
    expect(ids(view(graph, { tag: "#Maths" }), "note")).toEqual(["b", "a"]);
    expect(ids(view(graph, { folder: "Maths/" }), "note")).toEqual(["b", "a", "d"]);
    expect(ids(view(graph, { folder: "Maths", tag: "maths/algebra" }), "note")).toEqual(["b"]);
    const filtered = view(graph, { tag: "maths" });
    expect(filtered.matchingNotes).toBe(2);
    expect(filtered.totalNotes).toBe(4);
    // A link to a note outside the filter isn't drawn, and isn't a ghost either.
    expect(filtered.edges.filter((e) => e.kind === "link")).toEqual([]);
    expect(filtered.tags).toEqual([
      { name: "maths", notes: 1 },
      { name: "maths/algebra", notes: 1 },
      { name: "mathsy", notes: 1 },
    ]);
    expect(filtered.folders).toEqual([
      { path: "Maths", notes: 3 },
      { path: "Maths/Algebra", notes: 1 },
    ]);
  });

  it("draws the local graph around a focus to the depth asked, keeping the focus only if it matches", () => {
    const local = view(chain, { mode: "local", focus: "c", depth: 1 });
    expect(local.mode).toBe("local");
    expect(local.focus).toBe("c");
    expect(local.nodes.map((n) => [n.id, n.hops])).toEqual([["b", 1], ["c", 0], ["d", 1]]);
    expect(ids(view(chain, { mode: "local", focus: "c", depth: 2 }), "note")).toEqual(["a", "b", "c", "d", "e"]);
    // An unknown focus falls back to the note with the most connections, ties to the first by path.
    expect(view(chain, { mode: "local", focus: "nope", depth: 1 }).focus).toBe("b");
  });

  it("counts sharing a tag as one hop, and in the local graph draws only tags that connect what's drawn", () => {
    const graph: NoteGraph = { notes: [note("a", ["t", "solo"]), note("b", ["t"]), note("c", ["u"]), note("d", ["u"])], links: [link("b", "c")] };
    const v = view(graph, { mode: "local", focus: "a", depth: 1 });
    expect(ids(v)).toEqual(["a", "b", "tag:t", "tag:solo"]);
    expect(ids(view(graph, { mode: "local", focus: "a", depth: 2 }), "note")).toEqual(["a", "b", "c"]);
  });

  it("opens a large import on the local graph around its best-connected note", () => {
    const many = WHOLE_GRAPH_NOTES + 1;
    const notes = Array.from({ length: many }, (_, i) => note(`n${String(i).padStart(4, "0")}`));
    const hub = notes[700 % many]!.id;
    const links = notes.filter((n) => n.id !== hub).slice(0, 3).map((n) => link(hub, n.id));
    const v = view({ notes, links });
    expect(v.mode).toBe("local");
    expect(v.focus).toBe(hub);
    expect(ids(v, "note")).toHaveLength(4);
  });

  it("stays within its limits on a 10,000-note vault behind one tag", () => {
    const notes = Array.from({ length: 10_000 }, (_, i) => note(`n${String(i).padStart(5, "0")}`, ["all", `t${i % 600}`]));
    const links = notes.flatMap((n, i) => [link(n.id, notes[(i + 1) % notes.length]!.id), link(n.id, null, `ghost ${i}`)]);
    const started = performance.now();
    const v = view({ notes, links }, { focus: "n00042" });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(v.mode).toBe("local");
    expect(v.truncated).toBe(true);
    expect(ids(v, "note").length).toBe(MAX_GRAPH_VIEW_NOTES);
    expect(ids(v, "note")).toContain("n00042");
    expect(v.nodes.length).toBeLessThanOrEqual(MAX_GRAPH_VIEW_NODES);
    expect(v.edges.length).toBeLessThanOrEqual(MAX_GRAPH_VIEW_EDGES);
    const drawn = new Set(ids(v));
    expect(v.edges.every((e) => drawn.has(e.from) && drawn.has(e.to))).toBe(true);
    expect(v.tags.length).toBe(200);
  });

  it("lists the fullest folders, ties by path, as counting every folder of every note would", () => {
    // The plain way, which costs the square of a path's depth per note: fine for these few notes.
    const naive = (paths: string[]) => {
      const counts = new Map<string, number>();
      for (const path of paths) {
        const parts = path.split("/").slice(0, -1);
        for (let depth = 1; depth <= parts.length; depth++) counts.set(parts.slice(0, depth).join("/"), (counts.get(parts.slice(0, depth).join("/")) ?? 0) + 1);
      }
      return [...counts]
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_GRAPH_FACETS)
        .map(([path, notes]) => ({ path, notes }));
    };
    // Names that sort around "/" (" ", "-", ".", "0"), empty folders from "//", and many small folders, so the
    // limit cuts through ties.
    const names = ["a", "a b", "a-b", "a.b", "a0", "", "b"];
    let seed = 7;
    const random = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) % n);
    const paths = new Set<string>();
    while (paths.size < 1_500) {
      const depth = random(6);
      paths.add([...Array.from({ length: depth }, () => names[random(names.length)]!), `n${random(100_000)}.md`].join("/"));
    }
    const notes = [...paths].map((path, i) => note(`n${i}`, [], path));
    const folders = view({ notes, links: [] }, { tag: "none" }).folders;
    expect(folders).toHaveLength(MAX_GRAPH_FACETS);
    expect(folders).toEqual(naive([...paths]));
  });

  it("lists the folders of a 10,000-note vault hundreds of folders deep quickly", () => {
    // Paths just under 512 characters: counting every folder of every path took over a minute here.
    const deep = "a/".repeat(240);
    const shapes = [(i: number) => `${deep}n${i}.md`, (i: number) => `d${i}/${deep}n.md`, (i: number) => `d${i % 50}/${deep}n${i}.md`];
    for (const shape of shapes) {
      const notes = Array.from({ length: 10_000 }, (_, i) => note(`n${i}`, [], shape(i)));
      expect(notes[0]!.path.length).toBeLessThan(512);
      const started = performance.now();
      const v = view({ notes, links: [] }, { tag: "none" });
      // Well under 100 ms unloaded; generous for a busy machine.
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(v.nodes).toEqual([]);
      expect(v.folders).toHaveLength(MAX_GRAPH_FACETS);
    }
    const shared = view({ notes: Array.from({ length: 10_000 }, (_, i) => note(`n${i}`, [], shapes[0]!(i))), links: [] }, { tag: "none" });
    expect(shared.folders[0]).toEqual({ path: "a", notes: 10_000 });
    expect(shared.folders[MAX_GRAPH_FACETS - 1]).toEqual({ path: deep.slice(0, 2 * MAX_GRAPH_FACETS - 1), notes: 10_000 });
  });
});

describe("graph view API", () => {
  const auth = { Authorization: "Bearer t" };
  const app = createApp({ db: openDb(":memory:"), model: () => { throw new Error("no model in these tests"); }, security: { token: "t", allowedHosts: [] } });
  const get = (path: string) => app.request(`/api${path}`, { headers: auth });
  const files: VaultFile[] = [
    { path: "CS/Recursion.md", text: "---\ntags: [cs]\n---\nSee [[Stack]] and [[Nowhere]]." },
    { path: "CS/Stack.md", text: "#cs LIFO." },
    { path: "Recipes/100% rye.md", text: "Bread." },
  ];
  const created = (async () => {
    const res = await app.request("/api/imports", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Vault", files }) });
    return ((await res.json()) as { import: { id: string } }).import.id;
  })();

  it("returns the view for an import's filters", async () => {
    const id = await created;
    const res = await get(`/imports/${id}/graph/view?folder=CS&depth=1`);
    expect(res.status).toBe(200);
    const v = NoteGraphView.parse(await res.json());
    expect(v.nodes.map((n) => n.label).sort()).toEqual(["#cs", "Nowhere", "Recursion", "Stack"]);
    expect(v.folders).toEqual([
      { path: "CS", notes: 2 },
      { path: "Recipes", notes: 1 },
    ]);
    expect((await get(`/imports/${id}/graph/view?depth=9`)).status).toBe(400);
    expect((await get("/imports/nope/graph/view")).status).toBe(404);
  });

  it("finds notes by title or path, taking % literally", async () => {
    const id = await created;
    const find = async (q: string) => NoteSummary.array().parse(await (await get(`/imports/${id}/notes?q=${encodeURIComponent(q)}`)).json());
    expect((await find("stack")).map((n) => n.title)).toEqual(["Stack"]);
    expect((await find("cs/")).map((n) => n.title)).toEqual(["Stack", "Recursion"]);
    expect((await find("100%")).map((n) => n.title)).toEqual(["100% rye"]);
    expect(await find("1%r")).toEqual([]);
    expect((await get(`/imports/${id}/notes?q=`)).status).toBe(400);
    expect((await get("/imports/nope/notes?q=x")).status).toBe(404);
  });
});
