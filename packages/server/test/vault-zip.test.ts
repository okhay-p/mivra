import { MAX_NOTE_CHARS, MAX_VAULT_BYTES, MAX_VAULT_FILES, NoteGraph, VaultImportResult, VaultImportView } from "@mivra/protocol";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { commonTopFolder, MAX_VAULT_ZIP_ENTRIES, unzipVault } from "../src/notes/vault-zip.js";
import { makeZip, type ZipEntry } from "./support/files.js";

// Building the larger zips and starting the real subprocess both take seconds on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const auth = { authorization: "Bearer t" };

function setup(deps: Partial<AppDeps> = {}) {
  // In-process by default, since starting a subprocess takes seconds; one test below goes through the real one.
  const app = createApp({
    db: openDb(":memory:"),
    model: () => {
      throw new Error("no model in these tests");
    },
    security: { token: "t", allowedHosts: [] },
    unzipVault: (bytes) => unzipVault(bytes),
    ...deps,
  });
  const form = (zip: Uint8Array, filename: string, name?: string) => {
    const body = new FormData();
    if (name !== undefined) body.append("name", name);
    body.append("file", new Blob([zip as BlobPart]), filename);
    return body;
  };
  const post = (zip: Uint8Array, filename = "My Vault.zip", name?: string) => app.request("/api/imports/zip", { method: "POST", headers: auth, body: form(zip, filename, name) });
  const put = (id: string, zip: Uint8Array) => app.request(`/api/imports/${id}/zip`, { method: "PUT", headers: auth, body: form(zip, "vault.zip") });
  const graph = async (id: string) => NoteGraph.parse(await (await app.request(`/api/imports/${id}/graph`, { headers: auth })).json());
  const list = async () => VaultImportView.array().parse(await (await app.request("/api/imports", { headers: auth })).json());
  return { app, post, put, graph, list };
}

const result = async (res: Response, status: number) => {
  expect(res.status, await res.clone().text()).toBe(status);
  return VaultImportResult.parse(await res.json());
};
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const paths = async (graph: Promise<NoteGraph>) => (await graph).notes.map((n) => n.path).sort();

describe("commonTopFolder", () => {
  it("finds the one folder every entry sits in", () => {
    expect(commonTopFolder(["Vault/a.md", "Vault/sub/b.md"])).toBe("Vault");
    expect(commonTopFolder(["Vault/a.md", "Other/b.md"])).toBeUndefined();
    expect(commonTopFolder(["a.md", "Vault/b.md"])).toBeUndefined();
    expect(commonTopFolder([])).toBeUndefined();
  });
});

describe("importing a zipped vault", () => {
  it("imports its notes, drops a single top folder and macOS metadata, and names it after the zip", async () => {
    const { post, graph } = setup();
    const zip = makeZip([
      { name: "Vault/", data: "" },
      { name: "Vault/Recursion.md", data: "See [[Stack]]. #cs" },
      { name: "Vault/Data/Stack.md", data: "Push and pop." },
      { name: "__MACOSX/Vault/._Recursion.md", data: "resource fork" },
    ]);
    const body = await result(await post(zip), 201);
    expect(body.import).toMatchObject({ name: "My Vault", noteCount: 2 });
    expect(body).toMatchObject({ added: 2, skippedCount: 0 });
    expect(await paths(graph(body.import.id))).toEqual(["Data/Stack.md", "Recursion.md"]);
    expect((await graph(body.import.id)).links[0]!.to).not.toBeNull();
  });

  it("keeps the folders when entries don't share one top folder, and takes a name field", async () => {
    const { post, graph } = setup();
    const body = await result(await post(makeZip([{ name: "a.md", data: "A" }, { name: "Sub/b.md", data: "B" }]), "x.zip", "Course notes"), 201);
    expect(body.import.name).toBe("Course notes");
    expect(await paths(graph(body.import.id))).toEqual(["Sub/b.md", "a.md"]);
  });

  it("skips attachments and reports them, and leaves hidden folders out silently", async () => {
    const { post } = setup();
    const zip = makeZip([
      { name: "Vault/Note.md", data: "Text" },
      { name: "Vault/image.png", data: "png" },
      { name: "Vault/.obsidian/app.json", data: "{}" },
      { name: "Vault/.trash/Old.md", data: "gone" },
    ]);
    const body = await result(await post(zip), 201);
    expect(body.import.noteCount).toBe(1);
    expect(body.skippedCount).toBe(1);
    expect(body.skipped).toEqual([{ path: "image.png", reason: "not_markdown" }]);
  });

  it("never follows a symbolic link entry", async () => {
    const { post, graph } = setup();
    const zip = makeZip([
      { name: "Vault/Note.md", data: "Text" },
      { name: "Vault/Secrets.md", data: "../../../etc/passwd", mode: 0o120777 },
    ]);
    const body = await result(await post(zip), 201);
    expect(body.skipped).toEqual([{ path: "Secrets.md", reason: "symlink" }]);
    expect(await paths(graph(body.import.id))).toEqual(["Note.md"]);
  });

  it("refuses a zip with an entry named to climb out of the vault, or an absolute one", async () => {
    const { post, list } = setup();
    for (const name of ["Vault/../../evil.md", "/etc/evil.md", "Vault\\..\\evil.md"]) {
      const res = await post(makeZip([{ name: "Vault/Note.md", data: "Text" }, { name, data: "x" }]));
      expect(res.status, name).toBe(422);
      expect(await errorOf(res)).toMatch(/contains \.\./);
    }
    expect(await list()).toEqual([]);
  });

  it("accepts Windows backslashes as folders", async () => {
    const { post, graph } = setup();
    const body = await result(await post(makeZip([{ name: "Vault\\Sub\\Note.md", data: "Text" }, { name: "Vault\\Top.md", data: "T" }])), 201);
    expect(await paths(graph(body.import.id))).toEqual(["Sub/Note.md", "Top.md"]);
  });

  it("refuses a zip bomb by what its notes claim to unpack to, before unpacking them", async () => {
    const { post } = setup();
    const big = Buffer.alloc(4 * MAX_NOTE_CHARS, 0x61);
    const count = Math.ceil(MAX_VAULT_BYTES / big.length) + 1;
    const zip = makeZip(Array.from({ length: count }, (_, i): ZipEntry => ({ name: `Vault/n${i}.md`, data: big })));
    expect(zip.length).toBeLessThan(2 * 1024 * 1024);
    const res = await post(zip);
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatch(/more than 64 MB unpacked/);
  });

  it("refuses an entry that unpacks to more than it claims", async () => {
    const { post } = setup();
    const res = await post(makeZip([{ name: "Vault/Bomb.md", data: Buffer.alloc(20 * 1024 * 1024, 0x61), declaredSize: 100 }]));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatch(/damaged/);
  });

  it("skips a single note too long to import", async () => {
    const { post } = setup();
    const body = await result(await post(makeZip([{ name: "Vault/Ok.md", data: "fine" }, { name: "Vault/Huge.md", data: Buffer.alloc(4 * MAX_NOTE_CHARS + 1, 0x61) }])), 201);
    expect(body.skipped).toEqual([{ path: "Huge.md", reason: "too_long" }]);
    const chars = await result(await post(makeZip([{ name: "Vault/Ok.md", data: "fine" }, { name: "Vault/Long.md", data: Buffer.alloc(MAX_NOTE_CHARS + 1, 0x61) }]), "b.zip"), 201);
    expect(chars.skipped).toEqual([{ path: "Long.md", reason: "too_long" }]);
  });

  it("refuses too many entries, and too many notes", async () => {
    const { post } = setup();
    const entries = makeZip(Array.from({ length: MAX_VAULT_ZIP_ENTRIES + 1 }, (_, i): ZipEntry => ({ name: `Vault/f${i}.png`, data: "", stored: true })));
    const res = await post(entries);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatch(/entries/);
    const notes = makeZip(Array.from({ length: MAX_VAULT_FILES + 1 }, (_, i): ZipEntry => ({ name: `Vault/n${i}.md`, data: "x", stored: true })));
    const tooMany = await post(notes);
    expect(tooMany.status).toBe(422);
    expect(await errorOf(tooMany)).toMatch(/notes/);
  });

  it("refuses a zip over the upload limit as it's read", async () => {
    const { post } = setup();
    const res = await post(new Uint8Array(MAX_VAULT_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatch(/64 MB/);
  });

  it("refuses what isn't a zip, a zip without notes, and a password-protected one", async () => {
    const { post } = setup();
    expect((await post(new TextEncoder().encode("just text"))).status).toBe(415);
    const empty = await post(makeZip([{ name: "Vault/a.png", data: "x" }]));
    expect(empty.status).toBe(422);
    expect(await errorOf(empty)).toMatch(/No Markdown notes/);
    expect((await post(makeZip([{ name: "Vault/a.md", data: "x", encrypted: true }]))).status).toBe(422);
  });

  it("refuses a name that's taken or blank, and unexpected fields", async () => {
    const { app, post } = setup();
    const zip = makeZip([{ name: "Vault/a.md", data: "x" }]);
    await result(await post(zip, "Notes.zip"), 201);
    const taken = await post(zip, "Notes.zip");
    expect(taken.status).toBe(409);
    expect(await errorOf(taken)).toMatch(/already exists/);
    expect((await post(zip, "x.zip", "   ")).status).toBe(400);
    const extra = new FormData();
    extra.append("other", "x");
    extra.append("file", new Blob([zip as BlobPart]), "v.zip");
    expect((await app.request("/api/imports/zip", { method: "POST", headers: auth, body: extra })).status).toBe(400);
  });

  it("re-imports a zip as a snapshot", async () => {
    const { post, put, graph } = setup();
    const first = await result(await post(makeZip([{ name: "V/a.md", data: "A" }, { name: "V/b.md", data: "B" }, { name: "V/c.md", data: "C" }])), 201);
    const again = await result(await put(first.import.id, makeZip([{ name: "V/a.md", data: "A" }, { name: "V/b.md", data: "B changed" }, { name: "V/d.md", data: "D" }])), 200);
    expect(again).toMatchObject({ added: 1, updated: 1, removed: 1, unchanged: 1 });
    expect(again.import).toMatchObject({ id: first.import.id, name: "My Vault", noteCount: 3 });
    expect(await paths(graph(first.import.id))).toEqual(["a.md", "b.md", "d.md"]);
  });

  it("refuses a re-import of an unknown import, or one with a name field", async () => {
    const { app, post, put } = setup();
    expect((await put("nope", makeZip([{ name: "a.md", data: "A" }]))).status).toBe(404);
    const first = await result(await post(makeZip([{ name: "a.md", data: "A" }])), 201);
    const body = new FormData();
    body.append("name", "x");
    body.append("file", new Blob([makeZip([{ name: "a.md", data: "A" }]) as BlobPart]), "v.zip");
    expect((await app.request(`/api/imports/${first.import.id}/zip`, { method: "PUT", headers: auth, body })).status).toBe(400);
  });

  it("needs the token", async () => {
    const { app } = setup();
    expect((await app.request("/api/imports/zip", { method: "POST" })).status).toBe(401);
  });

  it("unpacks in the real subprocess by default", async () => {
    const { post } = setup({ unzipVault: undefined });
    const body = await result(await post(makeZip([{ name: "Vault/Note.md", data: "Text" }, { name: "Vault/x.png", data: "p" }])), 201);
    expect(body).toMatchObject({ added: 1, skippedCount: 1 });
  });

  it("documents both routes in OpenAPI", async () => {
    const { app } = setup();
    const doc = (await (await app.request("/api/doc", { headers: auth })).json()) as { paths: Record<string, Record<string, { requestBody?: { content: object } }>> };
    expect(doc.paths["/imports/zip"]!.post!.requestBody!.content).toHaveProperty("multipart/form-data");
    expect(doc.paths["/imports/{id}/zip"]!.put!.requestBody!.content).toHaveProperty("multipart/form-data");
  });
});
