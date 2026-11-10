import { VaultImportResult } from "@mivra/protocol";
import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { conceptEdges, conceptSources, concepts, memories, notes, runs, vaultImports } from "../src/db/schema.js";
import { isMivraGenerated } from "../src/notes/parse.js";
import { buildVault, escapeInline, safeFileName, type ExportInput } from "../src/notes/vault-export.js";
import { unzipVault } from "../src/notes/vault-zip.js";
import { zipStream } from "../src/notes/zip-writer.js";

vi.setConfig({ testTimeout: 60_000 });

const auth = { authorization: "Bearer t" };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const check = { concept: "Binary Search", question: "Worst case on 16 items?", options: [{ text: "4" }, { text: "5" }], correctOptionIndex: 1, explanation: "Five." };

type Step = { tool: string; input: unknown } | { text: string };

/** An app whose model plays `steps` in order; distilling isn't exercised here, so notes are written straight to the database. */
function setup(steps: Step[] = []) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++] ?? { text: "ok" };
      const chunks: object[] =
        "tool" in step
          ? [
              { type: "tool-call", toolCallId: `call_${call}`, toolName: step.tool, input: JSON.stringify(step.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
  const db = openDb(":memory:");
  const app = createApp({ db, model: () => model, security: { token: "t", allowedHosts: [] }, unzipVault: (bytes) => unzipVault(bytes) });
  const turn = async (sessionId: string, text: string) => {
    const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
    await (await app.request(`/api/sessions/${sessionId}/chat`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await vi.waitFor(() => expect(db.select().from(runs).where(eq(runs.sessionId, sessionId)).all().every((r) => r.status !== "running")).toBe(true));
  };
  const newSession = async () => ((await (await app.request("/api/sessions", { method: "POST", headers: auth })).json()) as { id: string }).id;
  /** Downloads the export and reads it back with yauzl, which checks every entry's size and CRC. */
  const download = async () => {
    const res = await app.request("/api/export/obsidian", { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Mivra-\d{4}-\d{2}-\d{2}\.zip"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, files: await readZip(bytes) };
  };
  return { app, db, turn, newSession, download };
}

function readZip(bytes: Uint8Array): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files = new Map<string, string>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, async (openError, stream) => {
          if (openError || !stream) return reject(openError);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(chunk as Buffer);
          files.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
          zip.readEntry();
        });
      });
      zip.on("end", () => resolve(files));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** Writes an import, notes, concepts, edges and memories as distilling would have. */
function seed(db: ReturnType<typeof openDb>) {
  const now = new Date("2026-11-09T10:00:00Z");
  db.insert(vaultImports).values({ id: "imp", name: "Vault", source: "obsidian", createdAt: now, updatedAt: now }).run();
  const note = (id: string, path: string, title: string) =>
    db.insert(notes).values({ id, importId: "imp", path, title, titleKey: title.toLowerCase(), aliases: [], body: "text", hash: id, distilledHash: id, createdAt: now, updatedAt: now }).run();
  note("n-search", "CS/Searching.md", "Searching");
  note("n-arrays", "CS/Arrays.md", "Arrays");
  // Two notes with one title: links to them name their paths.
  note("n-intro-a", "Week 1/Intro.md", "Intro");
  note("n-intro-b", "Week 2/Intro.md", "Intro");
  const concept = (id: string, name: string, sources: string[]) => {
    db.insert(concepts).values({ id, key: name.toLowerCase(), name, createdAt: now }).run();
    for (const noteId of sources) db.insert(conceptSources).values({ conceptId: id, noteId }).run();
  };
  concept("c-bs", "Binary search", ["n-search", "n-intro-a"]);
  concept("c-sorted", "Sorted arrays", ["n-arrays"]);
  concept("c-bad", "../../etc/passwd", ["n-intro-b"]);
  concept("c-con", "CON", ["n-arrays"]);
  db.insert(conceptEdges).values({ fromId: "c-sorted", toId: "c-bs", kind: "prerequisite", noteId: "n-search" }).run();
  db.insert(conceptEdges).values({ fromId: "c-bad", toId: "c-bs", kind: "related", noteId: "n-search" }).run();
  db.insert(memories)
    .values({ id: "m-known", kind: "known", text: "Knows binary search halves the range", concept: "Binary search", basis: "import", noteId: "n-search", status: "active", createdAt: now })
    .run();
  db.insert(memories)
    .values({ id: "m-goal", kind: "goal", text: "Pass interviews [[Searching]] <script>x</script>", concept: null, basis: "chat", status: "active", createdAt: now, editedAt: now })
    .run();
}

const frontmatterOf = (text: string) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

describe("exporting an Obsidian vault", () => {
  it("writes a Mivra folder of concepts and memories that link to each other and to the learner's notes by title", async () => {
    const { db, download } = setup();
    seed(db);
    const { files } = await download();
    expect([...files.keys()].sort()).toEqual([
      "Mivra/Concepts/Binary search.md",
      "Mivra/Concepts/Sorted arrays.md",
      "Mivra/Concepts/_CON.md",
      "Mivra/Concepts/etc passwd.md",
      "Mivra/Memories/Goal - Pass interviews Searching script x script.md",
      "Mivra/Memories/Known - Knows binary search halves the range.md",
      "Mivra/Mivra.md",
    ]);
    for (const [path, text] of files) expect(frontmatterOf(text), path).toMatch(/^mivra: generated$/m);

    const bs = files.get("Mivra/Concepts/Binary search.md")!;
    expect(bs).toContain("- [[Searching]]");
    expect(bs).toContain("- [[Week 1/Intro]]");
    expect(bs).toContain("## Builds on\n\n- [[Mivra/Concepts/Sorted arrays|Sorted arrays]]");
    expect(bs).toContain("## Related\n\n- [[Mivra/Concepts/etc passwd|../../etc/passwd]]");
    expect(bs).toContain("[[Mivra/Memories/Known - Knows binary search halves the range|Knows binary search halves the range]]");
    expect(files.get("Mivra/Concepts/Sorted arrays.md")).toContain("## Leads to\n\n- [[Mivra/Concepts/Binary search|Binary search]]");

    const known = files.get("Mivra/Memories/Known - Knows binary search halves the range.md")!;
    expect(frontmatterOf(known).split("\n")).toEqual([
      "mivra: generated",
      "type: memory",
      "kind: known",
      "basis: import",
      'concept: "Binary search"',
      'source: "[[Searching]]"',
      "created: 2026-11-09",
      "tags: [mivra/memory, mivra/known]",
    ]);
    expect(known).toContain("- Concept: [[Mivra/Concepts/Binary search|Binary search]]");
    // Text from the model or the learner can't open links or HTML.
    const goal = files.get("Mivra/Memories/Goal - Pass interviews Searching script x script.md")!;
    expect(goal).toContain("Pass interviews \\[\\[Searching\\]\\] \\<script\\>x\\</script\\>");
    expect(goal).toMatch(/^edited: 2026-11-09$/m);
    expect(goal).not.toMatch(/^source:/m);
  });

  it("leaves out a memory held until a check is answered, saying only that one is held", async () => {
    const { db, turn, newSession, download } = setup([
      { tool: "ask_multiple_choice", input: check },
      { tool: "remember", input: { kind: "goal", text: "SECRET the answer is 5" } },
      { text: "Try it." },
    ]);
    await turn(await newSession(), "quiz me");
    expect(db.select().from(memories).all()).toHaveLength(1);
    const { bytes, files } = await download();
    expect(Buffer.from(bytes).includes("SECRET")).toBe(false);
    expect([...files.keys()]).toEqual(["Mivra/Mivra.md"]);
    expect(files.get("Mivra/Mivra.md")).toContain("1 memory is left out for now");
  });

  it("re-imports a vault with the export in it without importing the export, by JSON and by zip", async () => {
    const { app, db, download } = setup();
    seed(db);
    const { files } = await download();
    const vault = [...[...files].map(([path, text]) => ({ path, text })), { path: "Recursion.md", text: "My own note." }];

    const res = await app.request("/api/imports", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Mine", files: vault }) });
    const json = VaultImportResult.parse(await res.json());
    expect(json).toMatchObject({ added: 1, skippedCount: files.size });
    expect(json.skipped.every((s) => s.reason === "generated")).toBe(true);

    const zip = new Uint8Array(await new Response(zipStream(vault.map((f) => ({ name: `Vault/${f.path}`, data: Buffer.from(f.text) })))).arrayBuffer());
    const body = new FormData();
    body.append("file", new Blob([zip as BlobPart]), "Zipped.zip");
    const zipped = VaultImportResult.parse(await (await app.request("/api/imports/zip", { method: "POST", headers: auth, body })).json());
    expect(zipped).toMatchObject({ added: 1, skippedCount: files.size, import: { noteCount: 1 } });
  });

  it("is behind the API token", async () => {
    const { app } = setup();
    expect((await app.request("/api/export/obsidian")).status).toBe(401);
  });
});

describe("safeFileName", () => {
  it("leaves no path, no reserved name and nothing Obsidian links refuse", () => {
    expect(safeFileName("../../etc/passwd")).toBe("etc passwd");
    expect(safeFileName("a/b\\c:d*e?f\"g<h>i|j#k^l[m]n")).toBe("a b c d e f g h i j k l m n");
    expect(safeFileName("..")).toBe("Untitled");
    expect(safeFileName(" . ", "Concept")).toBe("Concept");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("a..b")).toBe("a.b");
    expect(safeFileName("trailing. ")).toBe("trailing");
    expect(safeFileName("con")).toBe("_con");
    expect(safeFileName("LPT1.txt")).toBe("_LPT1.txt");
    expect(safeFileName("Console")).toBe("Console");
    expect(safeFileName("tab\there‮flip\u0000")).toBe("tab here flip");
  });

  it("caps the length in characters and in bytes, without splitting a character", () => {
    expect(safeFileName("x".repeat(500))).toHaveLength(80);
    const emoji = safeFileName("😀".repeat(100));
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(180);
    expect(emoji).toBe("😀".repeat(45));
  });
});

describe("buildVault", () => {
  const base: ExportInput = { concepts: [], edges: [], notes: [], memories: [], held: 0, exportedAt: new Date("2026-11-10T00:00:00Z") };

  it("makes names unique, ignoring case", () => {
    const files = buildVault({
      ...base,
      concepts: [
        { id: "a", name: "Recursion", notes: [] },
        { id: "b", name: "recursion", notes: [] },
        { id: "c", name: "Recursion/", notes: [] },
      ],
    });
    expect(files.map((f) => f.path)).toEqual(["Mivra/Mivra.md", "Mivra/Concepts/Recursion.md", "Mivra/Concepts/recursion 2.md", "Mivra/Concepts/Recursion 3.md"]);
  });

  it("names a note it can't link to in plain text", () => {
    const [, concept] = buildVault({
      ...base,
      concepts: [{ id: "a", name: "A", notes: ["n"] }],
      notes: [{ id: "n", title: "C# basics", titleKey: "c# basics", path: "C# basics.md" }],
    });
    expect(concept!.text).toContain("- C\\# basics");
  });

  it("escapes Markdown that would link, embed, hide or format text", () => {
    expect(escapeInline("![[x]] %%hidden%% $x$ <b>\n#tag")).toBe("!\\[\\[x\\]\\] \\%\\%hidden\\%\\% \\$x\\$ \\<b\\> \\#tag");
  });
});

describe("isMivraGenerated", () => {
  it("reads only the frontmatter", () => {
    expect(isMivraGenerated("---\nmivra: generated\n---\nText")).toBe(true);
    expect(isMivraGenerated("﻿---\r\ntype: concept\r\nMivra: 'generated'\r\n---\r\n")).toBe(true);
    expect(isMivraGenerated("---\ntitle: x\n---\nmivra: generated")).toBe(false);
    expect(isMivraGenerated("mivra: generated")).toBe(false);
    expect(isMivraGenerated("---\nmivra: generated by hand\n---\n")).toBe(false);
  });
});
