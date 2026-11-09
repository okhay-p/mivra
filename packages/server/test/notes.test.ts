import { MAX_VAULT_BYTES, NoteGraph, NoteView, VaultImportResult, VaultImportView, type VaultFile } from "@mivra/protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { noteChunks, noteLinks, noteTags, notes } from "../src/db/schema.js";
import { MAX_LINKS_PER_NOTE, parseNote } from "../src/notes/parse.js";
import { cleanVaultPath } from "../src/notes/vault-import.js";
import { createNoteStore } from "../src/store/note-store.js";

const auth = { authorization: "Bearer t" };

function setup(db: Db = openDb(":memory:")) {
  const app = createApp({ db, model: () => { throw new Error("no model in these tests"); }, security: { token: "t", allowedHosts: [] } });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const importVault = async (name: string, files: VaultFile[]) => {
    const res = await send("POST", "/imports", { name, files });
    expect(res.status).toBe(201);
    return VaultImportResult.parse(await res.json());
  };
  const reimport = async (id: string, files: VaultFile[]) => {
    const res = await send("PUT", `/imports/${id}/files`, { files });
    expect(res.status).toBe(200);
    return VaultImportResult.parse(await res.json());
  };
  const graph = async (id: string) => NoteGraph.parse(await (await send("GET", `/imports/${id}/graph`)).json());
  return { app, db, send, importVault, reimport, graph, store: createNoteStore(db) };
}

describe("parseNote", () => {
  it("reads the title from the file name, and aliases and tags from frontmatter", () => {
    const note = parseNote("Maths/Recursion.md", "---\ntitle: ignored\naliases:\n  - Recursive functions\n  - \"Self reference\"\ntags: [cs, Algorithms]\n---\nBody #Learning/Basics text.\n");
    expect(note.title).toBe("Recursion");
    expect(note.aliases).toEqual(["Recursive functions", "Self reference"]);
    expect(note.tags).toEqual(["cs", "algorithms", "learning/basics"]);
  });

  it("reads tags from block lists and older space-separated frontmatter", () => {
    expect(parseNote("a.md", "---\ntags:\n- one\n- two\n---\n").tags).toEqual(["one", "two"]);
    expect(parseNote("a.md", "---\ntags: one two, three\n---\n").tags).toEqual(["one", "two", "three"]);
  });

  it("keeps an unclosed frontmatter block as text", () => {
    const note = parseNote("a.md", "---\ntags: [x]\nno closing line");
    expect(note.tags).toEqual([]);
    expect(note.chunks[0]!.text).toContain("no closing line");
  });

  it("finds wiki links, embeds and Markdown links, without display text, headings or block ids", () => {
    const note = parseNote("Folder/Note.md", "See [[Recursion|recursing]], [[Stack#Push]] and [[Queue^abc]]. ![[Diagram note]] ![[image.png]] [rel](../Other%20Note.md) [abs](/Top/Root.md) [web](https://example.com/x.md)");
    expect(note.links).toEqual([
      { target: "Recursion", kind: "link" },
      { target: "Stack", kind: "link" },
      { target: "Queue", kind: "link" },
      { target: "Diagram note", kind: "embed" },
      { target: "Other Note", kind: "link" },
      { target: "Top/Root", kind: "link" },
    ]);
  });

  it("ignores links and tags inside code, and numbers, URLs and headings that look like tags", () => {
    const note = parseNote("a.md", "# Heading\n#real `[[not a link]] #nottag`\n```\n[[fenced]] #fenced\n```\nIssue #123 and https://x.y/#anchor\n~~~\n#also-fenced\n~~~\n");
    expect(note.links).toEqual([]);
    expect(note.tags).toEqual(["real"]);
  });

  it("chunks text under its heading path and packs small sections together", () => {
    const note = parseNote("a.md", "Intro.\n# Sorting\n## Merge sort\nSplit and merge.\n## Quick sort ##\nPivot.\n");
    expect(note.chunks).toEqual([{ seq: 0, heading: null, text: "Intro.\n\nSorting\n\nSorting > Merge sort\nSplit and merge.\n\nSorting > Quick sort\nPivot." }]);
    const long = parseNote("a.md", `# One\n${"word ".repeat(400)}\n# Two\n${"more ".repeat(400)}`);
    expect(long.chunks.map((c) => c.heading)).toEqual(["One", "One", "Two", "Two"]);
  });

  it("splits a long section into pieces that fit, at spaces where it can", () => {
    const words = parseNote("a.md", "word ".repeat(100_000));
    expect(words.chunks.every((c) => c.text.length <= 1200 && !c.text.startsWith(" "))).toBe(true);
    expect(words.chunks.map((c) => c.text).join(" ")).toBe("word ".repeat(100_000).trim());
    const solid = parseNote("a.md", "x".repeat(5000));
    expect(solid.chunks.map((c) => c.text.length)).toEqual([1200, 1200, 1200, 1200, 200]);
  });

  it("keeps headings with nothing under them searchable", () => {
    expect(parseNote("a.md", "# Merge sort\n## Complexity\n").chunks).toEqual([{ seq: 0, heading: "Merge sort", text: "Merge sort\n\nMerge sort > Complexity" }]);
  });

  it("caps headings, which are copied into every chunk under them", () => {
    const note = parseNote("a.md", `# ${"h".repeat(100_000)}\n${Array.from({ length: 1900 }, (_, i) => `## s${i}\n${"x".repeat(1100)}`).join("\n")}`);
    expect(note.chunks.every((c) => (c.heading?.length ?? 0) <= 300)).toBe(true);
    expect(note.chunks.reduce((sum, c) => sum + (c.heading?.length ?? 0), 0)).toBeLessThan(1_000_000);
  });

  it("keeps embeds of notes whose names contain dots", () => {
    expect(parseNote("a.md", "![[Version 1.0.md]] ![[Version 2.0]] ![[photo.JPEG]] ![[slides.pdf#page=2]]").links).toEqual([
      { target: "Version 1.0", kind: "embed" },
      { target: "Version 2.0", kind: "embed" },
    ]);
  });

  it("caps the links one note can add", () => {
    const text = Array.from({ length: MAX_LINKS_PER_NOTE + 5 }, (_, i) => `[[n${i}]]`).join(" ");
    const note = parseNote("a.md", text);
    expect(note.links).toHaveLength(MAX_LINKS_PER_NOTE);
    expect(note.truncated).toBe(true);
  });

  it("parses hostile lines in linear time", () => {
    const cases = [
      `# a${" ".repeat(200_000)}x`,
      "[".repeat(500_000),
      "[[".repeat(250_000),
      `[${"a".repeat(999)}](`.repeat(500),
      "#".repeat(500_000),
      ` ${"#a".repeat(250_000)}`,
      "`".repeat(500_000),
      `---\n${"tags: [a, b]\n".repeat(80_000)}`,
    ];
    for (const text of cases) {
      const started = performance.now();
      parseNote("a.md", text);
      expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(3000);
    }
  }, 60_000);
});

describe("cleanVaultPath", () => {
  it("accepts vault paths and refuses anything that could escape the vault", () => {
    expect(cleanVaultPath("Maths\\Recursion.md")).toEqual({ path: "Maths/Recursion.md" });
    expect(cleanVaultPath("./a/b.MD")).toEqual({ path: "a/b.MD" });
    for (const bad of ["/etc/passwd.md", "C:/x.md", "a/../../x.md", "a//b.md", "a/./b.md", "a\0.md"]) expect(cleanVaultPath(bad)).toEqual({ reason: "bad_path" });
    expect(cleanVaultPath(".obsidian/workspace.md")).toEqual({ reason: "hidden" });
    expect(cleanVaultPath("Notes/.trash/old.md")).toEqual({ reason: "hidden" });
    expect(cleanVaultPath("images/x.png")).toEqual({ reason: "not_markdown" });
  });
});

describe("vault import API", () => {
  const vault: VaultFile[] = [
    { path: "Recursion.md", text: "---\naliases: [Recursive functions]\ntags: [cs]\n---\nA function that calls itself. See [[Stack]] and [[Base case|base cases]]." },
    { path: "CS/Stack.md", text: "LIFO. Used by [[recursion]] via [[Call frames]]. #cs/data-structures" },
    { path: "CS/Base case.md", text: "Stops [[Recursive functions|the recursion]]. Also [[CS/Stack]] and [[cs/stack]]." },
    { path: ".obsidian/app.md", text: "config" },
    { path: "attachments/diagram.png", text: "" },
    { path: "cs/stack.md", text: "duplicate by case" },
  ];

  it("stores notes, skips non-notes, and resolves links by title, alias and path", async () => {
    const { importVault, graph, send } = setup();
    const result = await importVault("My vault", vault);
    expect(result).toMatchObject({ added: 3, updated: 0, removed: 0, unchanged: 0, skippedCount: 3, truncated: false });
    expect(result.skipped).toEqual([
      { path: ".obsidian/app.md", reason: "hidden" },
      { path: "attachments/diagram.png", reason: "not_markdown" },
      { path: "cs/stack.md", reason: "duplicate" },
    ]);
    expect(result.import).toMatchObject({ name: "My vault", source: "obsidian", noteCount: 3 });

    const { notes: nodes, links } = await graph(result.import.id);
    const id = (title: string) => nodes.find((n) => n.title === title)!.id;
    expect(nodes.find((n) => n.title === "Stack")!.tags).toEqual(["cs/data-structures"]);
    const edges = links.map((l) => [nodes.find((n) => n.id === l.from)!.title, l.to ? nodes.find((n) => n.id === l.to)!.title : null, l.target]);
    expect(edges).toEqual(
      expect.arrayContaining([
        ["Recursion", "Stack", "Stack"],
        ["Recursion", "Base case", "Base case"],
        ["Stack", "Recursion", "recursion"],
        ["Stack", null, "Call frames"],
        ["Base case", "Recursion", "Recursive functions"],
        ["Base case", "Stack", "CS/Stack"],
        ["Base case", "Stack", "cs/stack"],
      ]),
    );

    const note = NoteView.parse(await (await send("GET", `/notes/${id("Recursion")}`)).json());
    expect(note).toMatchObject({ path: "Recursion.md", aliases: ["recursive functions"], tags: ["cs"] });
    expect(note.body).toContain("calls itself");
  });

  it("re-imports as a snapshot: unchanged notes stay, changed ones keep their id, missing ones go", async () => {
    const { importVault, reimport, graph, db, store } = setup();
    const first = await importVault("v", vault.slice(0, 3));
    const before = await graph(first.import.id);
    const stackId = before.notes.find((n) => n.title === "Stack")!.id;

    const next = await reimport(first.import.id, [vault[0]!, { path: "CS/Stack.md", text: "Now about [[Queue]]. #changed" }, { path: "Queue.md", text: "FIFO." }]);
    expect(next).toMatchObject({ added: 1, updated: 1, removed: 1, unchanged: 1 });
    const after = await graph(first.import.id);
    expect(after.notes.map((n) => n.path)).toEqual(["CS/Stack.md", "Queue.md", "Recursion.md"]);
    expect(after.notes.find((n) => n.title === "Stack")).toMatchObject({ id: stackId, tags: ["changed"] });
    expect(after.links.filter((l) => l.from === stackId)).toEqual([{ from: stackId, to: after.notes.find((n) => n.title === "Queue")!.id, target: "Queue", kind: "link" }]);
    // Search follows the snapshot: the old text is gone, the new one is found.
    expect(store.searchNoteChunks('"lifo"', 5)).toEqual([]);
    expect(store.searchNoteChunks('"fifo"', 5).map((c) => c.title)).toEqual(["Queue"]);
    expect(db.select().from(notes).all()).toHaveLength(3);
  });

  it("searches chunks by heading and text", async () => {
    const { importVault, store } = setup();
    await importVault("v", [{ path: "Sorting.md", text: "# Merge sort\nDivide and conquer.\n" }]);
    expect(store.searchNoteChunks('"merge"', 5)).toMatchObject([{ title: "Sorting", heading: "Merge sort", text: "Divide and conquer." }]);
  });

  it("deletes an import with all its notes, links, tags and search entries", async () => {
    const { importVault, send, db, store } = setup();
    const result = await importVault("v", vault);
    expect((await send("DELETE", `/imports/${result.import.id}`)).status).toBe(204);
    expect((await send("DELETE", `/imports/${result.import.id}`)).status).toBe(404);
    for (const table of [notes, noteChunks, noteLinks, noteTags]) expect(db.select().from(table).all()).toEqual([]);
    expect(store.searchNoteChunks('"lifo"', 5)).toEqual([]);
    expect(VaultImportView.array().parse(await (await send("GET", "/imports")).json())).toEqual([]);
  });

  it("refuses a duplicate name, unknown imports and oversized bodies", async () => {
    const { importVault, send } = setup();
    await importVault("v", []);
    expect((await send("POST", "/imports", { name: "v", files: [] })).status).toBe(409);
    expect((await send("PUT", "/imports/nope/files", { files: [] })).status).toBe(404);
    expect((await send("GET", "/imports/nope/graph")).status).toBe(404);
    expect((await send("GET", "/notes/nope")).status).toBe(404);
    expect((await send("POST", "/imports", { name: "x", files: [{ path: "a.md", text: "x", extra: 1 }] })).status).toBe(400);
    const huge = await send("POST", "/imports", { name: "big", files: [{ path: "a.md", text: "x".repeat(MAX_VAULT_BYTES) }] });
    expect(huge.status).toBe(413);
  });

  it("keeps answering other requests while a large vault is parsed", async () => {
    const { send } = setup();
    const files = Array.from({ length: 1000 }, (_, i) => ({ path: `n${i}.md`, text: `# Note ${i}\n${"Some [[Link]] text and #tag. ".repeat(40)}` }));
    let finished = false;
    const importing = Promise.resolve(send("POST", "/imports", { name: "big", files })).then((res) => {
      finished = true;
      return res;
    });
    // Let the request start parsing, then ask for something else.
    await new Promise((r) => setTimeout(r, 30));
    expect((await send("GET", "/health")).status).toBe(200);
    expect(finished).toBe(false);
    expect((await importing).status).toBe(201);
  }, 60_000);

  it("requires the API token", async () => {
    const { app } = setup();
    expect((await app.request("/api/imports")).status).toBe(401);
  });
});
