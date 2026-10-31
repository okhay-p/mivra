import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import busboy from "busboy";
import { MAX_DOCUMENT_BYTES } from "@mivra/protocol";
import { DocumentError } from "./extract.js";

const MAX_FILENAME_CHARS = 120;
/** Room for the multipart boundary and headers around the file. */
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** About 13 Mbit/s would fill the size limit in 15 s; this allows for a slow link. */
const READ_TIMEOUT_MS = 120_000;

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

export interface ReadUploadOptions {
  maxBytes?: number;
  /** How long the whole body may take to arrive. */
  timeoutMs?: number;
  /** Stops reading, e.g. when the client disconnects. */
  signal?: AbortSignal;
}

/**
 * Reads a multipart body holding one part, a file in the field `file`, keeping at most the size limit
 * in memory. Whole-request bytes are counted before the parser and whatever Content-Length claimed, and
 * anything unexpected stops the read at once. Every way of stopping goes through `finish`, which destroys
 * all the streams, so nothing is left reading and none of their errors can go unhandled.
 */
export function readUpload(
  { body, contentType, contentLength }: UploadRequest,
  { maxBytes = MAX_DOCUMENT_BYTES, timeoutMs = READ_TIMEOUT_MS, signal }: ReadUploadOptions = {},
): Promise<{ filename: string; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const badRequest = new DocumentError("failed", "Send one file as multipart/form-data in a field called file.");
    const unfinished = new DocumentError("failed", "The upload didn't finish.");
    const cancelled = new DocumentError("failed", "The upload was cancelled.");
    const refuse = (error: DocumentError) => {
      void body?.cancel().catch(() => {});
      reject(error);
    };
    if (!body || !contentType?.toLowerCase().startsWith("multipart/form-data")) return refuse(badRequest);
    const maxRequestBytes = maxBytes + MAX_MULTIPART_OVERHEAD_BYTES;
    if (Number(contentLength) > maxRequestBytes) return refuse(new DocumentError("too_large", TOO_LARGE));
    if (signal?.aborted) return refuse(cancelled);

    let parser: busboy.Busboy;
    try {
      // Filenames arrive as UTF-8 from browsers; busboy's default strips any folders from them. It fires
      // "limit" on reaching fileSize, so one byte more lets a file of exactly the limit through. It counts
      // a part when the part ends, so parts: 2 can't fire on a lone file.
      parser = busboy({ headers: { "content-type": contentType }, defParamCharset: "utf8", limits: { files: 1, fields: 0, parts: 2, headerPairs: 8, fileSize: maxBytes + 1 } });
    } catch {
      return refuse(badRequest);
    }

    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
    const files = new Set<NodeJS.ReadableStream & { destroy(): void }>();
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        // Leaves `done` uncalled when failing: `fail` destroys this stream.
        if (received > maxRequestBytes) fail(new DocumentError("too_large", TOO_LARGE));
        else done(null, chunk);
      },
    });

    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      source.destroy();
      counter.destroy();
      settle();
      // Not synchronously: this can run inside busboy's own event, and it keeps using the file stream after
      // emitting. Destroying an unfinished parser reports errors, which `fail` ignores by now.
      setImmediate(() => {
        for (const stream of files) stream.destroy();
        parser.destroy();
      });
    };
    const fail = (error: DocumentError) => finish(() => reject(error));
    const onAbort = () => fail(cancelled);
    const timer = setTimeout(() => fail(new DocumentError("failed", "The upload took too long, so it was stopped.")), timeoutMs);
    signal?.addEventListener("abort", onAbort);

    let file: { filename: string; bytes: Uint8Array } | undefined;
    let reading = false;
    parser.on("file", (field: string, stream: NodeJS.ReadableStream & { truncated?: boolean; destroy(): void }, info: busboy.FileInfo) => {
      files.add(stream);
      // Busboy destroys an unfinished file with an error, which would be fatal without a listener.
      stream.on("error", () => fail(unfinished));
      if (field !== "file" || reading) return fail(badRequest);
      reading = true;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => fail(new DocumentError("too_large", TOO_LARGE)));
      stream.on("end", () => {
        if (!stream.truncated) file = { filename: info.filename ?? "", bytes: Buffer.concat(chunks) };
      });
    });
    for (const limit of ["filesLimit", "fieldsLimit", "partsLimit"] as const) parser.on(limit, () => fail(badRequest));
    parser.on("close", () => {
      const done = file;
      if (done) finish(() => resolve(done));
      else fail(badRequest);
    });
    parser.on("error", () => fail(unfinished));
    counter.on("error", () => fail(unfinished));
    source.on("error", () => fail(unfinished));
    source.pipe(counter).pipe(parser);
  });
}
