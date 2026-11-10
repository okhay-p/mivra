import { MAX_NOTE_CHARS, MAX_VAULT_BYTES, MAX_VAULT_FILES, type VaultImportResult, type VaultImportView } from "@mivra/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportsPanel } from "../src/ImportsPanel.js";
import { MAX_NOTE_BYTES, readPickedVault, selectNotes, splitPickedPath, type PickedFile } from "../src/vault-files.js";

// The panel tests render a dialog and step through several states, which takes seconds on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const picked = (webkitRelativePath: string, text = "note", size = text.length): PickedFile & { text: ReturnType<typeof vi.fn> } => ({
  name: webkitRelativePath.split("/").at(-1)!,
  webkitRelativePath,
  size,
  text: vi.fn(async () => text),
});

describe("reading a picked vault folder", () => {
  it("strips the picked folder's own name, which becomes the default name", () => {
    expect(splitPickedPath({ name: "a.md", webkitRelativePath: "Vault/Sub/a.md" })).toEqual({ folder: "Vault", path: "Sub/a.md" });
    expect(splitPickedPath({ name: "a.md", webkitRelativePath: "" })).toEqual({ folder: undefined, path: "a.md" });
  });

  it("keeps Markdown notes, leaves hidden folders out silently and counts everything else", async () => {
    const result = await readPickedVault([
      picked("Vault/b.md", "B"),
      picked("Vault/Sub/a.MD", "A"),
      picked("Vault/.obsidian/workspace.md"),
      picked("Vault/.trash/Old.md"),
      picked("Vault/Sub/.hidden.md"),
      picked("Vault/image.png"),
      picked("Vault/paper.pdf"),
    ]);
    expect(result).toEqual({ ok: true, vault: { folder: "Vault", files: [{ path: "b.md", text: "B" }, { path: "Sub/a.MD", text: "A" }], notMarkdown: 2, tooLong: [] } });
  });

  it("checks sizes before reading, and never reads a file too large to be a note", async () => {
    const huge = picked("Vault/Huge.md", "x", MAX_NOTE_BYTES + 1);
    const result = await readPickedVault([picked("Vault/ok.md"), huge]);
    expect(huge.text).not.toHaveBeenCalled();
    expect(result.ok && result.vault.tooLong).toEqual(["Huge.md"]);
  });

  it("leaves out a note over the character limit once read", async () => {
    const result = await readPickedVault([picked("Vault/Long.md", "x".repeat(MAX_NOTE_CHARS + 1))]);
    expect(result).toMatchObject({ ok: true, vault: { files: [], tooLong: ["Long.md"] } });
  });

  it("fails fast, reading nothing, when the notes together are over the budget", async () => {
    const files = Array.from({ length: 20 }, (_, i) => picked(`Vault/n${i}.md`, "x", MAX_NOTE_BYTES));
    const result = await readPickedVault(files);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/more than 64 MB/) });
    expect(files.every((f) => f.text.mock.calls.length === 0)).toBe(true);
    expect(MAX_NOTE_BYTES * 20).toBeGreaterThan(MAX_VAULT_BYTES);
  });

  it("refuses more notes than one import takes", () => {
    // Plain objects: this many mocks take seconds to make.
    const files = Array.from({ length: MAX_VAULT_FILES + 1 }, (_, i): PickedFile => ({ name: `n${i}.md`, webkitRelativePath: `Vault/n${i}.md`, size: 1, text: async () => "x" }));
    expect(selectNotes(files)).toEqual({ ok: false, error: expect.stringMatching(/more than 10,000 notes/) });
  });

  it("reports progress as it reads", async () => {
    const progress: [number, number][] = [];
    await readPickedVault([picked("V/a.md"), picked("V/b.md")], (read, total) => progress.push([read, total]));
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
  });
});

const view = (over: Partial<VaultImportView> = {}): VaultImportView => ({
  id: "i1",
  name: "Vault",
  source: "obsidian",
  noteCount: 2,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  distillation: { status: "idle", pendingNotes: 0, groups: 0, groupsDone: 0, error: null, concepts: 0, memories: 0 },
  ...over,
});
const importResult = (over: Partial<VaultImportResult> = {}): VaultImportResult => ({
  import: view(),
  added: 2,
  updated: 0,
  removed: 0,
  unchanged: 0,
  skippedCount: 0,
  skipped: [],
  truncated: false,
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function openPanel(...responses: Response[]) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  render(<ImportsPanel open onOpenChange={() => {}} />);
  return fetch;
}
const chooseFolder = (files: PickedFile[]) => fireEvent.change(screen.getByTestId("vault-folder-input"), { target: { files } });
const dialog = () => screen.getByRole("dialog", { name: /Import an Obsidian vault|Re-import/ });

const distillation = (over: Partial<VaultImportView["distillation"]> = {}): VaultImportView["distillation"] => ({
  status: "idle",
  pendingNotes: 0,
  groups: 0,
  groupsDone: 0,
  error: null,
  concepts: 0,
  memories: 0,
  ...over,
});

describe("ImportsPanel distillation", () => {
  it("shows progress while notes are read, follows it, and cancels it", async () => {
    const running = view({ distillation: distillation({ status: "running", pendingNotes: 3, groups: 4, groupsDone: 1, concepts: 2 }) });
    const fetch = openPanel(json([running]), json(distillation({ status: "running", pendingNotes: 3, groups: 4, groupsDone: 1 })), json([view({ distillation: distillation({ status: "cancelled", pendingNotes: 2, concepts: 2, memories: 1 }) })]));
    const entry = await screen.findByRole("listitem", { name: "Vault" });
    expect(within(entry).getByText("Reading notes for concepts… group 2 of 4")).toBeTruthy();
    expect(within(entry).getByRole("progressbar")).toBeTruthy();
    fireEvent.click(within(entry).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(String(fetch.mock.calls[1]![0])).toMatch(/\/api\/imports\/i1\/distillation$/));
    expect(fetch.mock.calls[1]![1]?.method).toBe("DELETE");
    // The list is polled while it runs, so the cancelled state arrives.
    expect(await within(entry).findByText("Cancelled. 2 notes not read for concepts yet.", undefined, { timeout: 5_000 })).toBeTruthy();
    expect(within(entry).getByText("So far: 2 concepts and 1 memory drawn from these notes.")).toBeTruthy();
    expect(within(entry).getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("shows a failure, offers to try again, and summarises what was drawn", async () => {
    const fetch = openPanel(
      json([view({ distillation: distillation({ status: "failed", pendingNotes: 2, error: "The model request failed." }) }), view({ id: "i2", name: "Done", distillation: distillation({ concepts: 5, memories: 4 }) })]),
      json(distillation({ status: "queued", pendingNotes: 2 })),
    );
    const failed = await screen.findByRole("listitem", { name: "Vault" });
    expect(within(failed).getByText("Reading notes for concepts stopped: The model request failed.")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "Done" })).getByText("5 concepts and 4 memories drawn from these notes.")).toBeTruthy();
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await within(failed).findByText("Waiting to read these notes for concepts…")).toBeTruthy();
    expect(fetch.mock.calls[1]![1]?.method).toBe("POST");
  });
});

describe("ImportsPanel", () => {
  it("lists imports with their note count and last update", async () => {
    openPanel(json([view({ noteCount: 1 }), view({ id: "i2", name: "Course", noteCount: 340 })]));
    const list = await screen.findByRole("list", { name: "Imported vaults" });
    expect(within(list).getByText("1 note · Updated " + new Date("2026-11-02T00:00:00.000Z").toLocaleDateString())).toBeTruthy();
    expect(within(list).getByText(/^340 notes/)).toBeTruthy();
  });

  it("says so when there are none, and imports a picked folder", async () => {
    const fetch = openPanel(json([]), json(importResult({ skipped: [], skippedCount: 0 }), 201));
    fireEvent.click(await screen.findByRole("button", { name: "Import a vault" }));
    expect(screen.getByText("No vaults imported yet")).toBeTruthy();
    chooseFolder([picked("Vault/a.md", "A"), picked("Vault/b.md", "B"), picked("Vault/pic.png"), picked("Vault/.obsidian/x.md")]);
    expect(await within(dialog()).findByText("2 notes found in Vault")).toBeTruthy();
    expect(within(dialog()).getByText("Left out: 1 other file.")).toBeTruthy();
    expect((within(dialog()).getByRole("textbox", { name: "Import name" }) as HTMLInputElement).value).toBe("Vault");

    fireEvent.click(within(dialog()).getByRole("button", { name: "Import" }));
    expect(await within(dialog()).findByText(/^Imported/)).toBeTruthy();
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toBe("/api/imports");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Vault", files: [{ path: "a.md", text: "A" }, { path: "b.md", text: "B" }] });
    const changes = within(dialog()).getByLabelText("What changed");
    expect(within(changes).getByText("Added").nextSibling?.textContent).toBe("2");
    expect(within(dialog()).getByText("Skipped 1 file, including 1 attachment or other file.")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("list", { name: "Imported vaults" })).toBeTruthy();
  });

  it("re-imports when the name is taken, with PUT", async () => {
    const fetch = openPanel(json([view()]), json(importResult({ added: 0, updated: 1, removed: 1, unchanged: 1 })));
    fireEvent.click(await screen.findByRole("button", { name: "Import a vault" }));
    chooseFolder([picked("Vault/a.md", "A")]);
    expect(await within(dialog()).findByText(/already exists, so this re-imports it/)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Re-import" }));
    expect(await within(dialog()).findByText(/^Re-imported/)).toBeTruthy();
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toBe("/api/imports/i1/files");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ files: [{ path: "a.md", text: "A" }] });
  });

  it("re-imports one import from its entry, without asking for a name", async () => {
    const fetch = openPanel(json([view({ name: "Course" })]), json(importResult({ import: view({ name: "Course" }) })));
    fireEvent.click(await screen.findByRole("button", { name: "Re-import" }));
    expect(screen.getByRole("dialog", { name: "Re-import Course" })).toBeTruthy();
    chooseFolder([picked("Other name/a.md", "A")]);
    await within(dialog()).findByText("1 note found in Other name");
    expect(within(dialog()).queryByRole("textbox", { name: "Import name" })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Re-import" }));
    await within(dialog()).findByText(/^Re-imported/);
    expect(String(fetch.mock.calls[1]![0])).toBe("/api/imports/i1/files");
  });

  it("says when a folder has no notes, or is too large, and lets the learner choose again", async () => {
    openPanel(json([]));
    fireEvent.click(await screen.findByRole("button", { name: "Import a vault" }));
    chooseFolder([picked("Vault/a.png")]);
    expect(await within(dialog()).findByText(/No Markdown notes were found/)).toBeTruthy();
    chooseFolder(Array.from({ length: 20 }, (_, i) => picked(`Vault/n${i}.md`, "x", MAX_NOTE_BYTES)));
    expect(await within(dialog()).findByText(/more than 64 MB/)).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Choose vault folder" })).toBeTruthy();
  });

  it("keeps the selection and shows the server's error when sending fails", async () => {
    openPanel(json([]), json({ error: "An import can send at most 64 MB." }, 413));
    fireEvent.click(await screen.findByRole("button", { name: "Import a vault" }));
    chooseFolder([picked("Vault/a.md")]);
    fireEvent.click(await within(dialog()).findByRole("button", { name: "Import" }));
    expect(await within(dialog()).findByText("An import can send at most 64 MB.")).toBeTruthy();
    expect(within(dialog()).getByText("1 note found in Vault")).toBeTruthy();
  });

  it("shows progress while sending", async () => {
    let answer!: (res: Response) => void;
    const fetch = openPanel(json([]));
    fetch.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    fireEvent.click(await screen.findByRole("button", { name: "Import a vault" }));
    chooseFolder([picked("Vault/a.md")]);
    fireEvent.click(await within(dialog()).findByRole("button", { name: "Import" }));
    expect(await within(dialog()).findByText("Sending 1 note…")).toBeTruthy();
    answer(json(importResult(), 201));
    expect(await within(dialog()).findByText(/^Imported/)).toBeTruthy();
  });

  it("uploads a .zip instead, named after the zip", async () => {
    const fetch = openPanel(json([]), json(importResult({ import: view({ name: "My notes" }), skippedCount: 3, skipped: [{ path: "a.png", reason: "not_markdown" }, { path: "l.md", reason: "symlink" }] }), 201));
    fireEvent.click(await screen.findByRole("button", { name: "Import a vault" }));
    expect(within(dialog()).getByRole("button", { name: "Upload a .zip instead" })).toBeTruthy();
    const zip = new File([new Uint8Array([0x50, 0x4b])], "My notes.zip", { type: "application/zip" });
    fireEvent.change(screen.getByTestId("vault-zip-input"), { target: { files: [zip] } });
    expect((await within(dialog()).findByRole("textbox", { name: "Import name" }) as HTMLInputElement).value).toBe("My notes");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Import" }));
    expect(await within(dialog()).findByText("Skipped 3 files.")).toBeTruthy();
    expect(within(dialog()).getByText("l.md (link to another file)")).toBeTruthy();
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toBe("/api/imports/zip");
    const body = init?.body as FormData;
    expect(body.get("name")).toBe("My notes");
    expect((body.get("file") as File).name).toBe("My notes.zip");
  });

  it("deletes an import only after confirming", async () => {
    const fetch = openPanel(json([view()]), new Response(null, { status: 204 }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Delete this import and its 2 notes, with the concepts and memories drawn from them\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Imported vaults" })).toBeNull());
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toMatch(/\/api\/imports\/i1$/);
    expect(init?.method).toBe("DELETE");
  });
});
