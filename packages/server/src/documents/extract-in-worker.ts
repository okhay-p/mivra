import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DocumentError, type DocumentErrorCode, type ExtractedDocument } from "./extract.js";

/** Allows for a long textbook: pdf.js takes about 25-40 ms a page, off the main thread. */
const TIMEOUT_MS = 120_000;
/** JavaScript heap for one extraction. */
const MAX_HEAP_MB = 512;
/** Decoded streams live outside the heap, so a PDF's compression bomb has to be caught by watching the process. */
const MAX_RSS_GROWTH_BYTES = 2 * 1024 * 1024 * 1024;
const RSS_CHECK_MS = 100;

const TOO_COMPLEX = "This file needs too much memory to read safely.";

export interface ExtractOptions {
  timeoutMs?: number;
  maxHeapMb?: number;
  maxRssGrowthBytes?: number;
  /** Stops the extraction, e.g. when the client disconnects. */
  signal?: AbortSignal;
}

export type Extract = (bytes: Uint8Array, options?: ExtractOptions) => Promise<ExtractedDocument>;

/** The worker as built, or from source through tsx in dev and tests. */
function workerTarget(): { url: URL; execArgv?: string[] } {
  if (!import.meta.url.endsWith(".ts")) return { url: new URL("./extract-worker.js", import.meta.url) };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { url: new URL("./extract-worker.ts", import.meta.url), execArgv: ["--import", tsx] };
}

/**
 * Extracts a file's text on a separate thread, so a slow or hostile file can't stall chat. Terminating
 * the thread stops even a parser stuck in a loop. Rejects only with DocumentError.
 */
export const extractInWorker: Extract = (bytes, { timeoutMs = TIMEOUT_MS, maxHeapMb = MAX_HEAP_MB, maxRssGrowthBytes = MAX_RSS_GROWTH_BYTES, signal } = {}) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DocumentError("failed", "The upload was cancelled."));
    const copy = new Uint8Array(bytes);
    const { url, execArgv } = workerTarget();
    const worker = new Worker(url, {
      workerData: { bytes: copy },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
      stdout: true,
      stderr: true,
      ...(execArgv ? { execArgv } : {}),
    });
    const startRss = process.memoryUsage.rss();

    let settled = false;
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(rssCheck);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      act();
    };
    const fail = (code: DocumentErrorCode, message: string) => settle(() => reject(new DocumentError(code, message)));
    const onAbort = () => fail("failed", "The upload was cancelled.");

    const timer = setTimeout(() => fail("timeout", "Reading this file took too long, so it was stopped."), timeoutMs);
    const rssCheck = setInterval(() => {
      if (process.memoryUsage.rss() - startRss > maxRssGrowthBytes) fail("too_complex", TOO_COMPLEX);
    }, RSS_CHECK_MS);
    signal?.addEventListener("abort", onAbort);

    worker.once("message", (result: { ok: true; document: ExtractedDocument } | { ok: false; code: DocumentErrorCode; message: string }) => {
      if (result.ok) settle(() => resolve(result.document));
      else fail(result.code, result.message);
    });
    worker.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") fail("too_complex", TOO_COMPLEX);
      else fail("failed", "Couldn't read this file.");
    });
    worker.once("exit", () => fail("failed", "Couldn't read this file."));
  });
