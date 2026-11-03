/**
 * Where a reply's blocks get parsed and typeset. Model text can be crafted to take minutes in the parser, so a
 * large block goes to a worker that can be killed: a render that runs past its deadline, or that nobody wants any
 * more and doesn't finish promptly, costs the worker its life and the block shows as plain text. Small blocks,
 * which no one has found a way to make slow, render on the spot, so ordinary replies and streaming deltas show at
 * once with no flash of raw text.
 */
import { renderMarkdown, type RenderedBlock } from "./render-markdown.js";

export interface RenderRequest {
  id: number;
  text: string;
}

/** No block means the parser threw, and the text should show as plain text. */
export interface RenderResponse {
  id: number;
  block?: RenderedBlock;
}

/** "plain" means the block couldn't be rendered in time, or at all, and shows as plain text. */
export type BlockResult = RenderedBlock | "plain";

export interface BlockRenderer {
  /** The result if it's ready without waiting: cached, or small enough to render now. */
  peek(text: string): BlockResult | undefined;
  /** Renders off the main thread. Resolves to undefined if the signal aborts first. */
  render(text: string, signal: AbortSignal): Promise<BlockResult | undefined>;
  /** Cancels everything and stops the worker. */
  dispose(): void;
}

/** The part of a Worker this uses, so tests can stand in for one. */
export interface WorkerLike {
  postMessage(message: RenderRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface WorkerRendererOptions {
  /** Longest a block may take in the worker before it's killed. Its replacement starts on the next block. */
  timeoutMs?: number;
  /** How long a render nobody wants any more may keep the worker before it's killed. */
  cancelGraceMs?: number;
  /** Blocks up to this many characters render on the main thread. */
  syncLimit?: number;
}

// About 1,500 formulas in one paragraph renders in seconds on a slow machine, so this is generous: it only bounds
// how long a hostile block holds up the blocks queued behind it.
const TIMEOUT_MS = 8_000;
// Far longer than an ordinary block takes, and far shorter than respawning the worker after every delta would cost.
const CANCEL_GRACE_MS = 250;
const SYNC_LIMIT = 2_000;
const CACHE_SIZE = 300;

/** Results by text, least recently used first. */
class ResultCache {
  private readonly entries = new Map<string, BlockResult>();
  get(text: string) {
    const result = this.entries.get(text);
    if (result !== undefined) {
      this.entries.delete(text);
      this.entries.set(text, result);
    }
    return result;
  }
  set(text: string, result: BlockResult) {
    this.entries.delete(text);
    this.entries.set(text, result);
    if (this.entries.size > CACHE_SIZE) this.entries.delete(this.entries.keys().next().value!);
  }
}

function renderNow(text: string): BlockResult {
  try {
    return renderMarkdown(text);
  } catch {
    return "plain";
  }
}

/** Renders every block on the main thread, for environments with no workers. */
export function createSyncRenderer(): BlockRenderer {
  const cache = new ResultCache();
  const peek = (text: string) => {
    let result = cache.get(text);
    if (result === undefined) cache.set(text, (result = renderNow(text)));
    return result;
  };
  return { peek, render: async (text) => peek(text), dispose() {} };
}

interface Job {
  id: number;
  text: string;
  signal: AbortSignal;
  resolve: (result: BlockResult | undefined) => void;
  onAbort: () => void;
}

export function createWorkerRenderer(spawn: () => WorkerLike, options: WorkerRendererOptions = {}): BlockRenderer {
  const { timeoutMs = TIMEOUT_MS, cancelGraceMs = CANCEL_GRACE_MS, syncLimit = SYNC_LIMIT } = options;
  const cache = new ResultCache();
  const queue: Job[] = [];
  let worker: WorkerLike | undefined;
  let running: { job: Job; deadline: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout> } | undefined;
  let nextId = 1;

  const ensureWorker = () => {
    if (worker) return worker;
    const created = spawn();
    created.onmessage = (event) => {
      if (worker === created && running?.job.id === event.data.id) finish(event.data.block ?? "plain");
    };
    created.onerror = () => {
      if (worker === created) kill("plain");
    };
    return (worker = created);
  };

  const settle = (job: Job, result: BlockResult | undefined) => {
    job.signal.removeEventListener("abort", job.onAbort);
    job.resolve(job.signal.aborted ? undefined : result);
  };

  /** Ends the running job. A result is cached; undefined means it was abandoned. */
  const finish = (result: BlockResult | undefined) => {
    const current = running!;
    running = undefined;
    clearTimeout(current.deadline);
    clearTimeout(current.grace);
    if (result !== undefined) cache.set(current.job.text, result);
    settle(current.job, result);
    pump();
  };

  /** The worker may be stuck in the parser, which only ends with the worker. */
  const kill = (result: BlockResult | undefined) => {
    worker?.terminate();
    worker = undefined;
    finish(result);
  };

  const pump = () => {
    while (!running && queue.length > 0) {
      const job = queue.shift()!;
      const cached = cache.get(job.text);
      if (cached !== undefined) {
        settle(job, cached);
        continue;
      }
      running = { job, deadline: setTimeout(() => kill("plain"), timeoutMs) };
      try {
        ensureWorker().postMessage({ id: job.id, text: job.text });
      } catch {
        kill("plain");
      }
    }
  };

  return {
    peek(text) {
      const cached = cache.get(text);
      if (cached !== undefined || text.length > syncLimit) return cached;
      const result = renderNow(text);
      cache.set(text, result);
      return result;
    },
    dispose() {
      for (const job of queue.splice(0)) settle(job, undefined);
      if (running) kill(undefined);
    },
    render(text, signal) {
      if (signal.aborted) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const job: Job = {
          id: nextId++,
          text,
          signal,
          resolve,
          onAbort: () => {
            const queued = queue.indexOf(job);
            if (queued >= 0) {
              queue.splice(queued, 1);
              settle(job, undefined);
            } else if (running?.job === job && running.grace === undefined) {
              running.grace = setTimeout(() => kill(undefined), cancelGraceMs);
            }
          },
        };
        signal.addEventListener("abort", job.onAbort);
        queue.push(job);
        pump();
      });
    },
  };
}
