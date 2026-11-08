import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { MAX_NOTE_CHARS, MAX_VAULT_BYTES, MAX_VAULT_FILES, VaultImportResult, VaultImportView, type VaultFile } from "@mivra/protocol";
import { TOKEN_FILE } from "../../server/src/security.js";
import { running } from "./state.js";

/**
 * `mivra import obsidian <folder>` (ADR-014): reads a vault's Markdown files on this machine and sends them to the
 * running Mivra, which alone writes the database (ADR-002). Importing the same name again re-imports that vault.
 */

export type VaultFiles = { files: VaultFile[]; tooLong: string[] };

export class VaultReadError extends Error {}

/**
 * The vault's `.md` files, with paths relative to its root. Hidden folders (`.obsidian`, `.trash`, `.git`) and
 * symbolic links are skipped, so nothing outside the vault is read. Walks with a stack, so deep folders can't
 * overflow the call stack.
 */
export function readVault(root: string): VaultFiles {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new VaultReadError(`${root} doesn't exist.`);
  }
  if (!stat.isDirectory()) throw new VaultReadError(`${root} isn't a folder. Give the vault's folder, the one that holds its notes.`);
  const files: VaultFile[] = [];
  const tooLong: string[] = [];
  const folders = [root];
  let bytes = 0;
  while (folders.length > 0) {
    const folder = folders.pop()!;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) folders.push(full);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        if (files.length >= MAX_VAULT_FILES) throw new VaultReadError(`The vault has more than ${MAX_VAULT_FILES} notes, more than one import can take.`);
        const path = relative(root, full).split(sep).join("/");
        // Sizes are checked before reading, so a huge vault fails fast instead of filling memory. A UTF-8 file has at
        // least as many bytes as characters, so a file over the character limit by bytes alone may still fit; one
        // over four times it can't.
        const size = statSync(full).size;
        if (size > MAX_NOTE_CHARS * 4) {
          tooLong.push(path);
          continue;
        }
        bytes += size;
        if (bytes > MAX_VAULT_BYTES) throw new VaultReadError(`The vault's notes come to more than ${MAX_VAULT_BYTES / (1024 * 1024)} MB, more than one import can take.`);
        const text = readFileSync(full, "utf8");
        if (text.length > MAX_NOTE_CHARS) tooLong.push(path);
        else files.push({ path, text });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, tooLong };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function importObsidian(
  folder: string,
  name: string | undefined,
  dataDir: string,
  io: { out: (message: string) => void; err: (message: string) => void },
): Promise<number> {
  const root = resolve(folder);
  let vault: VaultFiles;
  try {
    vault = readVault(root);
  } catch (error) {
    if (!(error instanceof VaultReadError)) throw error;
    io.err(error.message);
    return 1;
  }
  const importName = (name ?? basename(root)).trim();
  if (vault.files.length === 0) {
    io.err(`No Markdown notes found in ${root}.`);
    return 1;
  }

  const server = await running(dataDir);
  if (!server) {
    io.err("Mivra isn't running. Start it with `mivra start --detach`, then import again.");
    return 1;
  }
  let token: string;
  try {
    token = readFileSync(join(dataDir, TOKEN_FILE), "utf8").trim();
  } catch {
    io.err(`Couldn't read Mivra's API token from ${join(dataDir, TOKEN_FILE)}.`);
    return 1;
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const listed = await fetch(`${server.url}/api/imports`, { headers });
  if (!listed.ok) {
    io.err(`Mivra refused to list imports (${listed.status}).`);
    return 1;
  }
  const existing = VaultImportView.array().parse(await listed.json()).find((i) => i.name === importName);
  const body = JSON.stringify(existing ? { files: vault.files } : { name: importName, files: vault.files });
  if (Buffer.byteLength(body) > MAX_VAULT_BYTES) {
    io.err(`The vault's notes come to more than ${MAX_VAULT_BYTES / (1024 * 1024)} MB, more than one import can take.`);
    return 1;
  }
  const res = await fetch(existing ? `${server.url}/api/imports/${existing.id}/files` : `${server.url}/api/imports`, {
    method: existing ? "PUT" : "POST",
    headers,
    body,
  });
  if (!res.ok) {
    const message = ((await res.json().catch(() => ({}))) as { error?: unknown }).error;
    io.err(`The import failed (${res.status})${typeof message === "string" ? `: ${message}` : "."}`);
    return 1;
  }
  const result = VaultImportResult.parse(await res.json());
  io.out(
    `${existing ? "Re-imported" : "Imported"} "${result.import.name}": ${result.added} added, ${result.updated} updated, ${result.removed} removed, ${result.unchanged} unchanged. ${plural(result.import.noteCount, "note")} in all.`,
  );
  const skipped = [...vault.tooLong.map((path) => `${path} (over ${MAX_NOTE_CHARS.toLocaleString("en")} characters)`), ...result.skipped.map((s) => `${s.path} (${s.reason.replace("_", " ")})`)];
  const skippedCount = vault.tooLong.length + result.skippedCount;
  if (skippedCount > 0) io.out(`Skipped ${plural(skippedCount, "file")}: ${skipped.slice(0, 5).join(", ")}${skippedCount > 5 ? ", …" : ""}.`);
  if (result.truncated) io.out("Some links or tags were left out: a note or the vault had more than Mivra keeps.");
  return 0;
}
