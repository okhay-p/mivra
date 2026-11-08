import { MAX_VAULT_BYTES, SkipReason, VaultFile, VaultImportInput, type VaultImportResult } from "@mivra/protocol";
import { z } from "zod";
import { runInChild, type ExtractOptions } from "../documents/extract-in-child.js";
import { DocumentError } from "../documents/extract.js";
import { readUpload, sanitizeFilename, type UploadRequest } from "../documents/upload.js";
import type { NoteStore } from "../store/note-store.js";
import { importVault } from "./vault-import.js";
import type { UnzippedVault } from "./vault-zip.js";

/**
 * Imports a vault uploaded as a .zip, for browsers that can't pick a folder (ADR-014). The upload is read like a
 * document's (ADR-010), unpacked in the extraction subprocess, and then imported exactly as a JSON import is.
 */

/** Each import holds up to MAX_VAULT_BYTES of zip and of notes in memory, and runs a subprocess. */
const MAX_CONCURRENT_ZIP_IMPORTS = 1;

export type UnzipVault = (bytes: Uint8Array, options?: ExtractOptions) => Promise<UnzippedVault>;

/** Only what the child should send: notes within the import's limits, and skipped paths. */
const ChildVault = z.object({ files: VaultImportInput.shape.files, skipped: z.array(z.object({ path: z.string(), reason: SkipReason }).strict()) }).strict();

export const unzipVaultInChild: UnzipVault = (bytes, options) =>
  runInChild("vault-zip", bytes, (value) => {
    const parsed = ChildVault.safeParse(value);
    return parsed.success ? { files: parsed.data.files as VaultFile[], skipped: parsed.data.skipped } : undefined;
  }, options);

export type ZipImportError = {
  kind: "not_found" | "duplicate_name" | "bad_request" | "too_large" | "wrong_type" | "unreadable" | "busy";
  message: string;
};

const errorKinds: Record<DocumentError["code"], ZipImportError["kind"]> = {
  too_large: "too_large",
  wrong_type: "wrong_type",
  no_text: "unreadable",
  encrypted: "unreadable",
  corrupt: "unreadable",
  too_complex: "unreadable",
  timeout: "unreadable",
  failed: "bad_request",
};

/** The import's name: the one sent, or the zip's file name without `.zip`. */
function importName(field: string | undefined, filename: string): string | undefined {
  const fromFile = filename ? sanitizeFilename(filename).replace(/\.zip$/i, "") : "";
  const parsed = VaultImportInput.shape.name.safeParse(field ?? fromFile);
  return parsed.success ? parsed.data : undefined;
}

export function createZipImporter({ store, unzip = unzipVaultInChild, readTimeoutMs }: { store: NoteStore; unzip?: UnzipVault; readTimeoutMs?: number }) {
  let importing = 0;
  return async (
    target: { new: true } | { importId: string },
    upload: UploadRequest,
    signal?: AbortSignal,
  ): Promise<{ ok: true; result: VaultImportResult } | { ok: false; error: ZipImportError }> => {
    const refuse = (kind: ZipImportError["kind"], message: string) => {
      void upload.body?.cancel().catch(() => {});
      return { ok: false as const, error: { kind, message } };
    };
    if ("importId" in target && !store.findImport(target.importId)) return refuse("not_found", "Import not found");
    if (importing >= MAX_CONCURRENT_ZIP_IMPORTS) return refuse("busy", "Another vault is still importing. Try again in a moment.");

    importing++;
    try {
      const { filename, bytes, fields } = await readUpload(upload, {
        maxBytes: MAX_VAULT_BYTES,
        signal,
        fields: "importId" in target ? [] : ["name"],
        ...(readTimeoutMs ? { timeoutMs: readTimeoutMs } : {}),
      });
      let name: string | undefined;
      if (!("importId" in target)) {
        name = importName(fields.name, filename);
        if (!name) return { ok: false, error: { kind: "bad_request", message: "Give the import a name of up to 120 characters." } };
        // Saves unpacking a vault that can't be stored; createImport has the final say.
        if (store.listImports().some((i) => i.name === name)) return { ok: false, error: { kind: "duplicate_name", message: `An import called "${name}" already exists.` } };
      }
      const vault = await unzip(bytes, { signal });
      if (vault.files.length === 0) return { ok: false, error: { kind: "unreadable", message: "No Markdown notes were found in this zip." } };
      const outcome = await importVault(store, "importId" in target ? { importId: target.importId, files: vault.files } : { name: name!, files: vault.files }, vault.skipped);
      if (!outcome.ok) return { ok: false, error: { kind: outcome.kind, message: outcome.message } };
      return { ok: true, result: outcome.result };
    } catch (error) {
      if (error instanceof DocumentError) return { ok: false, error: { kind: errorKinds[error.code], message: error.message } };
      throw error;
    } finally {
      importing--;
    }
  };
}

export type ImportZip = ReturnType<typeof createZipImporter>;
