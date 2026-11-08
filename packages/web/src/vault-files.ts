import { MAX_NOTE_CHARS, MAX_VAULT_BYTES, MAX_VAULT_FILES, type VaultFile } from "@mivra/protocol";

/**
 * Reading a vault folder the learner picked (ADR-014), with the same rules as `mivra import obsidian`: hidden
 * folders and files (`.obsidian`, `.trash`) and anything not ending in `.md` are left out, and sizes are checked
 * before any file is read, so a huge folder fails fast instead of filling the tab's memory.
 */

/** What a picked file offers; `File` has all of it. */
export interface PickedFile {
  name: string;
  size: number;
  webkitRelativePath: string;
  text(): Promise<string>;
}

/** A UTF-8 note has at least as many bytes as characters, so one over four times the limit can't fit. */
export const MAX_NOTE_BYTES = MAX_NOTE_CHARS * 4;
const MB = 1024 * 1024;

export type PickedVault = {
  /** The picked folder's own name, the import's default name. */
  folder: string | undefined;
  files: VaultFile[];
  /** Files that aren't notes, such as images and PDFs. */
  notMarkdown: number;
  /** Notes too long to import. */
  tooLong: string[];
};

export type ReadVaultResult = { ok: true; vault: PickedVault } | { ok: false; error: string };

/**
 * A picked file's path inside the vault. The browser gives paths from the picked folder, whose own name is the
 * first segment; without a relative path (a single file) the name is the path.
 */
export function splitPickedPath(file: Pick<PickedFile, "name" | "webkitRelativePath">): { folder: string | undefined; path: string } {
  const segments = (file.webkitRelativePath || file.name).split("/");
  if (segments.length < 2) return { folder: undefined, path: segments[0]! };
  return { folder: segments[0], path: segments.slice(1).join("/") };
}

/** Sorts the picked files into notes to read and files left out, without reading any of them. */
export function selectNotes(picked: ArrayLike<PickedFile>) {
  let folder: string | undefined;
  const notes: { path: string; file: PickedFile }[] = [];
  const tooLong: string[] = [];
  let notMarkdown = 0;
  let bytes = 0;
  for (const file of Array.from(picked)) {
    const split = splitPickedPath(file);
    folder ??= split.folder;
    const { path } = split;
    if (path.split("/").some((segment) => segment.startsWith(".") || segment === "")) continue;
    if (!/\.md$/i.test(path)) {
      notMarkdown++;
      continue;
    }
    if (file.size > MAX_NOTE_BYTES) {
      tooLong.push(path);
      continue;
    }
    if (notes.length >= MAX_VAULT_FILES) return { ok: false as const, error: `This folder has more than ${MAX_VAULT_FILES.toLocaleString("en")} notes, more than one import can take.` };
    bytes += file.size;
    if (bytes > MAX_VAULT_BYTES) return { ok: false as const, error: `This folder's notes come to more than ${MAX_VAULT_BYTES / MB} MB, more than one import can take.` };
    notes.push({ path, file });
  }
  notes.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true as const, folder, notes, tooLong, notMarkdown };
}

/** Reads the picked folder's notes one at a time, reporting progress, after checking every size first. */
export async function readPickedVault(picked: ArrayLike<PickedFile>, onProgress?: (read: number, total: number) => void): Promise<ReadVaultResult> {
  const selected = selectNotes(picked);
  if (!selected.ok) return selected;
  const { folder, notes, notMarkdown } = selected;
  const tooLong = [...selected.tooLong];
  const files: VaultFile[] = [];
  onProgress?.(0, notes.length);
  for (const [i, { path, file }] of notes.entries()) {
    let text: string;
    try {
      text = await file.text();
    } catch {
      return { ok: false, error: `Couldn't read ${path}. It may have been moved or deleted; choose the folder again.` };
    }
    if (text.length > MAX_NOTE_CHARS) tooLong.push(path);
    else files.push({ path, text });
    onProgress?.(i + 1, notes.length);
  }
  return { ok: true, vault: { folder, files, notMarkdown, tooLong } };
}
