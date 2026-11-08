import { unzipVault } from "../notes/vault-zip.js";
import { DocumentError, extractDocument } from "./extract.js";

/**
 * The entry of an extraction subprocess (see extract-in-child.ts): reads one file sent over IPC, reports
 * its text (a document's, or a zipped vault's notes) or a DocumentError, and exits. The parent enforces the memory limits and kills this process if
 * it runs too long, so nothing here needs to clean up.
 */
const send = (message: unknown) => process.send!(message, () => process.exit(0));

// The parent is gone, so nobody is waiting for the result.
process.once("disconnect", () => process.exit(0));
process.once("message", async (message: { task?: unknown; bytes?: unknown; reportRss?: unknown }) => {
  // Where the parent can't read this process's memory from /proc, it relies on these reports.
  if (message?.reportRss === true) setInterval(() => process.send!({ rss: process.memoryUsage.rss() }), 100).unref();
  try {
    if (!(message?.bytes instanceof Uint8Array)) throw new DocumentError("failed", "Couldn't read this file.");
    if (message.task === "vault-zip") send({ ok: true, value: await unzipVault(message.bytes) });
    else if (message.task === "document") send({ ok: true, value: await extractDocument(message.bytes) });
    else throw new DocumentError("failed", "Couldn't read this file.");
  } catch (error) {
    send(
      error instanceof DocumentError
        ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: "corrupt", message: "This file looks damaged and can't be read." },
    );
  }
});
