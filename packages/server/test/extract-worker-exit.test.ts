import { afterEach, describe, expect, it, vi } from "vitest";
import { extractInWorker } from "../src/documents/extract-in-worker.js";
import { DocumentError } from "../src/documents/extract.js";
import { makePdf } from "./support/files.js";

const { workers } = vi.hoisted(() => ({ workers: [] as { exited: boolean; terminate: () => Promise<number> }[] }));

/** The real Worker, noting when each thread really exits. */
vi.mock("node:worker_threads", async (original) => {
  const real = await original<typeof import("node:worker_threads")>();
  class TrackedWorker extends real.Worker {
    exited = false;
    constructor(...args: ConstructorParameters<typeof real.Worker>) {
      super(...args);
      this.once("exit", () => (this.exited = true));
      workers.push(this);
    }
  }
  return { ...real, Worker: TrackedWorker };
});

vi.setConfig({ testTimeout: 60_000 });

const file = () => makePdf(Array.from({ length: 200 }, () => ["Plenty of ordinary words to read on each of these pages."]));

afterEach(() => {
  workers.length = 0;
  vi.restoreAllMocks();
});

describe("the extraction worker's lifetime", () => {
  it.each([
    ["the timeout", () => extractInWorker(file(), { timeoutMs: 20 })],
    [
      "an abort",
      () => {
        const controller = new AbortController();
        const running = extractInWorker(file(), { signal: controller.signal });
        controller.abort();
        return running;
      },
    ],
  ])("has exited by the time %s is reported", async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(DocumentError);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.exited).toBe(true);
  });

  it("has exited by the time a result is returned", async () => {
    await expect(extractInWorker(makePdf([["Plenty of ordinary words to read on this page."]]))).resolves.toMatchObject({ kind: "pdf" });
    expect(workers[0]!.exited).toBe(true);
  });

  it("waits for termination, however long it takes", async () => {
    let finishTerminating = (_code: number) => {};
    const running = extractInWorker(file(), { timeoutMs: 20 });
    const real = workers[0]!.terminate.bind(workers[0]);
    let terminating = false;
    workers[0]!.terminate = () =>
      new Promise((resolve) => {
        terminating = true;
        finishTerminating = resolve;
      });
    const settled = vi.fn();
    void running.catch(settled);
    await vi.waitFor(() => expect(terminating).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();
    finishTerminating(await real());
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  });
});
