import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import busboy from "busboy";
import { MAX_DOCUMENT_BYTES } from "@mivra/protocol";
import { DocumentError } from "./extract.js";

const MAX_FILENAME_CHARS = 120;
/** Room for the multipart boundary and headers around the file. */
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const TOO_LARGE = `This file is over the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit.`;

/**
 * A name that's safe to display and to give the model: no folders, no control or invisible characters
 * (such as the bidi overrides that disguise a file's extension), and a limited length that keeps the extension.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
  if (!clean || /^\.+$/.test(clean)) return "document";
  const chars = [...clean];
  if (chars.length <= MAX_FILENAME_CHARS) return clean;
  const extension = /\.[^. ]{1,8}$/.exec(clean)?.[0] ?? "";
  return `${chars.slice(0, MAX_FILENAME_CHARS - 1 - extension.length).join("").trimEnd()}…${extension}`;
}

export interface UploadRequest {
  body: ReadableStream<Uint8Array> | null;
  contentType: string | undefined;
  contentLength: string | undefined;
}

/**
 * Reads the multipart body's `file` field, keeping at most the size limit in memory: it stops reading
 * the request as soon as the limit is passed, whatever Content-Length claimed.
 */
export function readUpload({ body, contentType, contentLength }: UploadRequest, maxBytes = MAX_DOCUMENT_BYTES): Promise<{ filename: string; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const badRequest = new DocumentError("failed", "Send the file as multipart/form-data in a field called file.");
    if (!body || !contentType?.toLowerCase().startsWith("multipart/form-data")) return reject(badRequest);
    if (Number(contentLength) > maxBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
      void body.cancel().catch(() => {});
      return reject(new DocumentError("too_large", TOO_LARGE));
    }

    let parser: busboy.Busboy;
    try {
      // Filenames arrive as UTF-8 from browsers; busboy's default strips any folders from them. It fires
      // "limit" on reaching fileSize, so one byte more lets a file of exactly the limit through.
      parser = busboy({ headers: { "content-type": contentType }, defParamCharset: "utf8", limits: { files: 1, fields: 0, parts: 4, headerPairs: 8, fileSize: maxBytes + 1 } });
    } catch {
      return reject(badRequest);
    }
    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
    const stop = (error: DocumentError) => {
      source.destroy();
      reject(error);
    };
    let file: { filename: string; bytes: Uint8Array } | undefined;
    let reading = false;

    parser.on("file", (field: string, stream: NodeJS.ReadableStream & { truncated?: boolean }, info: busboy.FileInfo) => {
      if (field !== "file" || reading) {
        stream.resume();
        return;
      }
      reading = true;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => stop(new DocumentError("too_large", TOO_LARGE)));
      stream.on("end", () => {
        if (!stream.truncated) file = { filename: info.filename ?? "", bytes: Buffer.concat(chunks) };
      });
    });
    parser.on("close", () => (file ? resolve(file) : reject(badRequest)));
    parser.on("error", () => stop(badRequest));
    source.on("error", () => reject(new DocumentError("failed", "The upload didn't finish.")));
    source.pipe(parser);
  });
}
