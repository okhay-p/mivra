import { MAX_NOTE_CHARS, MAX_VAULT_BYTES, MAX_VAULT_FILES, type VaultFile } from "@mivra/protocol";
import yauzl from "yauzl";
import { DocumentError } from "../documents/extract.js";
import { cleanVaultPath, type SkippedFile } from "./vault-path.js";

/**
 * Unpacks a zipped Obsidian vault's notes (ADR-014). The zip is hostile (ADR-010), so this runs in the extraction
 * subprocess (see extract-in-child.ts), which adds a timeout and memory limits. Entries are only ever read into
 * memory, never written to disk under their stored names, and only `.md` entries are unpacked at all.
 */

/** Every entry, including attachments and folders, which are listed but never unpacked. */
export const MAX_VAULT_ZIP_ENTRIES = 50_000;
/** A UTF-8 note has at least as many bytes as characters, so one over four times the limit can't fit. */
const MAX_NOTE_BYTES = MAX_NOTE_CHARS * 4;

export interface UnzippedVault {
  files: VaultFile[];
  /** Entries left out before importing: attachments, symbolic links and notes that are too long. */
  skipped: SkippedFile[];
}

const NOT_A_ZIP = "This isn't a .zip file.";
const CORRUPT = "This zip looks damaged and can't be read.";
const TOO_BIG = `The vault's notes come to more than ${MAX_VAULT_BYTES / (1024 * 1024)} MB unpacked, more than one import can take.`;
const UNSAFE_NAME = "This zip has an entry whose name starts with / or contains .., so it was refused.";

/** Unix file type bits, kept in the top half of an entry's external attributes. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const isSymlink = (entry: yauzl.Entry) => ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;

/**
 * A zip of a vault usually holds the vault's own folder, so when every entry sits under one top folder, that folder
 * is dropped from the paths. macOS adds `__MACOSX/` beside it, which is ignored entirely.
 */
export function commonTopFolder(names: string[]): string | undefined {
  let top: string | undefined;
  for (const name of names) {
    const slash = name.indexOf("/");
    // A file at the top level means there's no wrapper folder.
    if (slash <= 0) return undefined;
    const first = name.slice(0, slash);
    if (top === undefined) top = first;
    else if (top !== first) return undefined;
  }
  return top;
}

const isMacMetadata = (name: string) => name === "__MACOSX" || name.startsWith("__MACOSX/");

function zipError(error: Error): DocumentError {
  if (/^(absolute path|invalid relative path|invalid characters)/.test(error.message)) return new DocumentError("corrupt", UNSAFE_NAME);
  if (/end of central directory record signature not found/i.test(error.message)) return new DocumentError("wrong_type", NOT_A_ZIP);
  return new DocumentError("corrupt", CORRUPT);
}

export function unzipVault(bytes: Uint8Array): Promise<UnzippedVault> {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // yauzl refuses absolute names and ".." for us; strictFileNames: false turns Windows backslashes into slashes
    // first. validateEntrySizes stops an entry that unpacks to more than it claims, so the size checks hold.
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: false, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(zipError(openError ?? new Error()));
      let settled = false;
      const fail = (error: DocumentError) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      if (zip.entryCount > MAX_VAULT_ZIP_ENTRIES) return fail(new DocumentError("too_complex", `This zip has more than ${MAX_VAULT_ZIP_ENTRIES.toLocaleString("en")} entries, more than one import can take.`));

      const entries: yauzl.Entry[] = [];
      zip.on("error", (error: Error) => fail(zipError(error)));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.isEncrypted()) return fail(new DocumentError("encrypted", "This zip is password-protected. Zip the vault again without a password."));
        if (!entry.fileName.endsWith("/") && !isMacMetadata(entry.fileName)) entries.push(entry);
        zip.readEntry();
      });
      zip.on("end", () => {
        void unpack(zip, entries).then(
          (vault) => {
            if (settled) return;
            settled = true;
            zip.close();
            resolve(vault);
          },
          (error: unknown) => fail(error instanceof DocumentError ? error : new DocumentError("corrupt", CORRUPT)),
        );
      });
      zip.readEntry();
    });
  });
}

/** Picks the notes from the listed entries, checks the limits against their declared sizes, then unpacks only those. */
async function unpack(zip: yauzl.ZipFile, entries: yauzl.Entry[]): Promise<UnzippedVault> {
  const top = commonTopFolder(entries.map((e) => e.fileName));
  const skipped: SkippedFile[] = [];
  const notes: { path: string; entry: yauzl.Entry }[] = [];
  let declared = 0;
  for (const entry of entries) {
    const path = top === undefined ? entry.fileName : entry.fileName.slice(top.length + 1);
    const cleaned = cleanVaultPath(path);
    if ("reason" in cleaned) {
      // Hidden folders hold Obsidian's settings and trash: leaving them out isn't news, as with the folder picker.
      if (cleaned.reason !== "hidden") skipped.push({ path, reason: cleaned.reason });
      continue;
    }
    if (isSymlink(entry)) {
      skipped.push({ path, reason: "symlink" });
      continue;
    }
    if (entry.uncompressedSize > MAX_NOTE_BYTES) {
      skipped.push({ path, reason: "too_long" });
      continue;
    }
    if (notes.length >= MAX_VAULT_FILES) throw new DocumentError("too_complex", `This zip has more than ${MAX_VAULT_FILES.toLocaleString("en")} notes, more than one import can take.`);
    declared += entry.uncompressedSize;
    if (declared > MAX_VAULT_BYTES) throw new DocumentError("too_large", TOO_BIG);
    notes.push({ path: cleaned.path, entry });
  }

  const decoder = new TextDecoder("utf-8");
  const files: VaultFile[] = [];
  for (const { path, entry } of notes) {
    const text = decoder.decode(await read(zip, entry));
    if (text.length > MAX_NOTE_CHARS) skipped.push({ path, reason: "too_long" });
    else files.push({ path, text });
  }
  return { files, skipped };
}

/** One entry's bytes, stopping at its declared size whatever the stream does. */
function read(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error instanceof Error ? zipError(error) : new DocumentError("corrupt", CORRUPT));
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > entry.uncompressedSize) stream.destroy(new Error("too much data"));
        else chunks.push(chunk);
      });
      stream.on("error", () => reject(new DocumentError("corrupt", CORRUPT)));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}
