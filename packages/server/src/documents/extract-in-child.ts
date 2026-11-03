import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DocumentError, type DocumentErrorCode, type ExtractedDocument } from "./extract.js";

/** Allows for a long textbook: pdf.js takes about 25-40 ms a page. */
const TIMEOUT_MS = 120_000;
/** JavaScript heap for one extraction. */
const MAX_HEAP_MB = 512;
/**
 * The whole subprocess's resident memory. Decoded streams live outside the heap, so a PDF's compression
 * bomb has to be caught by watching the process, and only this one: the server's own memory doesn't count.
 */
const MAX_RSS_BYTES = 2 * 1024 * 1024 * 1024;
const RSS_CHECK_MS = 100;
/** How long a process asked to stop with SIGTERM has before it's sent SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Enough of stderr to recognise V8's out-of-memory report. */
const STDERR_TAIL_CHARS = 4096;

const TOO_COMPLEX = "This file needs too much memory to read safely.";
const UNREADABLE = "Couldn't read this file.";
const CANCELLED = "The upload was cancelled.";

export interface ExtractOptions {
  timeoutMs?: number;
  maxHeapMb?: number;
  maxRssBytes?: number;
  /** Between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Stops the extraction, e.g. when the client disconnects. */
  signal?: AbortSignal;
}

export type Extract = (bytes: Uint8Array, options?: ExtractOptions) => Promise<ExtractedDocument>;

type ChildResult = { ok: true; document: ExtractedDocument } | { ok: false; code: DocumentErrorCode; message: string };

const errorCodes = new Set<string>(["too_large", "wrong_type", "no_text", "encrypted", "corrupt", "too_complex", "timeout", "failed"]);

/** Only trusts a message shaped like the child's report; anything else is a failure. */
function parseResult(message: unknown): ChildResult | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, unknown>;
  if (m.ok === true) {
    const d = m.document as Record<string, unknown> | null | undefined;
    const valid =
      typeof d === "object" &&
      d !== null &&
      (d.kind === "pdf" || d.kind === "pptx") &&
      Number.isInteger(d.pageCount) &&
      Array.isArray(d.pages) &&
      d.pages.every((p: unknown) => typeof p === "object" && p !== null && Number.isInteger((p as { page?: unknown }).page) && typeof (p as { text?: unknown }).text === "string");
    return valid ? { ok: true, document: d as unknown as ExtractedDocument } : undefined;
  }
  if (m.ok === false && typeof m.code === "string" && errorCodes.has(m.code) && typeof m.message === "string") {
    return { ok: false, code: m.code as DocumentErrorCode, message: m.message };
  }
  return undefined;
}

/** The child's entry as built, or from source through tsx in dev and tests. */
function childTarget(): { path: string; execArgv: string[] } {
  if (!import.meta.url.endsWith(".ts")) return { path: fileURLToPath(new URL("./extract-child.js", import.meta.url)), execArgv: [] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { path: fileURLToPath(new URL("./extract-child.ts", import.meta.url)), execArgv: ["--import", tsx] };
}

/** The child's resident memory, read from /proc where there is one; elsewhere the child reports it. */
async function procRss(pid: number): Promise<number | undefined> {
  try {
    const pages = Number((await readFile(`/proc/${pid}/statm`, "utf8")).split(" ")[1]);
    return Number.isFinite(pages) ? pages * 4096 : undefined;
  } catch {
    return undefined;
  }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Extracts a file's text in a separate Node process, so a slow or hostile file can't stall chat or take
 * the server down: a native crash or running out of memory only ends the child. The child gets its own
 * heap limit and its resident memory is watched; a timeout, cancellation or limit sends SIGTERM, then
 * SIGKILL after a grace period. The promise settles only once the child has exited, so a caller's
 * capacity is freed only when the work really has stopped. Rejects only with DocumentError.
 */
export const extractInChild: Extract = (
  bytes,
  { timeoutMs = TIMEOUT_MS, maxHeapMb = MAX_HEAP_MB, maxRssBytes = MAX_RSS_BYTES, killGraceMs = KILL_GRACE_MS, signal } = {},
) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DocumentError("failed", CANCELLED));
    const { path, execArgv } = childTarget();
    let child: ChildProcess;
    try {
      child = fork(path, [], {
        execArgv: [...execArgv, `--max-old-space-size=${maxHeapMb}`],
        // Nothing from the server's environment, such as API keys, reaches the code reading the file.
        env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch {
      return reject(new DocumentError("failed", UNREADABLE));
    }

    // The first decision wins; it's delivered when the child has exited.
    let outcome: (() => void) | undefined;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stderrTail = "";

    const finish = () => {
      clearTimeout(timer);
      clearInterval(rssCheck);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      child.removeAllListeners("message");
      child.stderr?.removeAllListeners("data");
      child.stderr?.destroy();
      (outcome ?? (() => reject(new DocumentError("failed", UNREADABLE))))();
    };
    const decide = (act: () => void) => {
      if (outcome) return;
      outcome = act;
      clearTimeout(timer);
      clearInterval(rssCheck);
      if (exited) return finish();
      if (alive(child)) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (alive(child)) child.kill("SIGKILL");
        }, killGraceMs);
      }
    };
    const fail = (code: DocumentErrorCode, message: string) => decide(() => reject(new DocumentError(code, message)));
    const onAbort = () => fail("failed", CANCELLED);

    const timer = setTimeout(() => fail("timeout", "Reading this file took too long, so it was stopped."), timeoutMs);
    let reportedRss = 0;
    let checking = false;
    const rssCheck = setInterval(() => {
      if (checking || child.pid === undefined) return;
      checking = true;
      void procRss(child.pid).then((rss) => {
        checking = false;
        if ((rss ?? reportedRss) > maxRssBytes) fail("too_complex", TOO_COMPLEX);
      });
    }, RSS_CHECK_MS);
    signal?.addEventListener("abort", onAbort);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("message", (message: unknown) => {
      // Where /proc is missing the child's own reports stand in, while its event loop runs.
      if (typeof message === "object" && message !== null && typeof (message as { rss?: unknown }).rss === "number" && !("ok" in message)) {
        reportedRss = (message as { rss: number }).rss;
        return;
      }
      const result = parseResult(message);
      if (!result) fail("failed", UNREADABLE);
      else if (result.ok) decide(() => resolve(result.document));
      else fail(result.code, result.message);
    });
    child.on("error", () => {
      // A child that never started has nothing to wait for.
      if (child.pid === undefined && !exited) {
        exited = true;
        if (!outcome) outcome = () => reject(new DocumentError("failed", UNREADABLE));
        finish();
      } else fail("failed", UNREADABLE);
    });
    // "close" rather than "exit": it also waits for stderr, which tells running out of heap apart.
    child.once("close", () => {
      if (exited) return;
      exited = true;
      if (!outcome) {
        if (/heap out of memory|Allocation failed/i.test(stderrTail)) fail("too_complex", TOO_COMPLEX);
        else fail("failed", UNREADABLE);
      }
      finish();
    });

    child.send({ bytes, reportRss: process.platform !== "linux" }, (error) => {
      if (error) fail("failed", UNREADABLE);
    });
  });
