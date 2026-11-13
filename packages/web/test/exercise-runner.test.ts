import { afterEach, describe, expect, it, vi } from "vitest";
import { caseInput, createCaseRunner, RunStopped } from "../src/exercise-runner.js";

/** A worker that answers only when told to, recording what it was sent and whether it was terminated. */
function fakeWorker() {
  const target = new EventTarget();
  const sent: { id: number; kind: string; testCase?: unknown }[] = [];
  const worker = {
    terminated: false,
    sent,
    postMessage: (message: { id: number; kind: string; testCase?: unknown }) => sent.push(message),
    terminate() {
      worker.terminated = true;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    reply: (data: unknown) => target.dispatchEvent(new MessageEvent("message", { data })),
    crash: () => target.dispatchEvent(new Event("error", { cancelable: true })),
  };
  return worker;
}

afterEach(() => vi.useRealTimers());

describe("the exercise case runner", () => {
  it("sends only the case's input, never its expected result", () => {
    expect(caseInput({ kind: "call", args: "[1]", hidden: false, expected: { returned: "2" } })).toEqual({ kind: "call", args: "[1]" });
    expect(caseInput({ kind: "stdio", stdin: "x", hidden: true })).toEqual({ kind: "stdio", stdin: "x" });
  });

  it("returns what the worker reports for that case", async () => {
    const worker = fakeWorker();
    const runner = createCaseRunner({ spawn: () => worker });
    const pending = runner.run("code", "f", { kind: "call", args: "[]" });
    worker.reply({ id: worker.sent[0]!.id + 1, ok: true, run: { stdout: "stale" } });
    worker.reply({ id: worker.sent[0]!.id, ok: true, run: { stdout: "", returned: "1" } });
    await expect(pending).resolves.toEqual({ stdout: "", returned: "1" });
  });

  it("terminates a worker that overruns the hard limit, reports a time limit, and starts a fresh one", async () => {
    vi.useFakeTimers();
    const workers = [fakeWorker(), fakeWorker()];
    let spawned = 0;
    const runner = createCaseRunner({ spawn: () => workers[spawned++]!, hardLimitMs: 1_000 });
    const stuck = runner.run("while (true) {}", undefined, { kind: "stdio", stdin: "" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stuck).resolves.toMatchObject({ error: expect.stringMatching(/^Time limit exceeded/) });
    expect(workers[0]!.terminated).toBe(true);

    const next = runner.run("1", undefined, { kind: "stdio", stdin: "" });
    expect(spawned).toBe(2);
    workers[1]!.reply({ id: workers[1]!.sent[0]!.id, ok: true, run: { stdout: "" } });
    await expect(next).resolves.toEqual({ stdout: "" });
  });

  it("stops the case in progress at once", async () => {
    const worker = fakeWorker();
    const runner = createCaseRunner({ spawn: () => worker });
    const pending = runner.run("while (true) {}", undefined, { kind: "stdio", stdin: "" });
    runner.stop();
    await expect(pending).rejects.toBeInstanceOf(RunStopped);
    expect(worker.terminated).toBe(true);
  });

  it("times a slow-loading runtime's case from when it starts, not from when it was sent", async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const runner = createCaseRunner({ spawn: () => worker, hardLimitMs: 1_000, startupLimitMs: 10_000 });
    const onStart = vi.fn();
    const pending = runner.run("print(1)", undefined, { kind: "stdio", stdin: "" }, { onStart });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.terminated).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    worker.reply({ id: worker.sent[0]!.id, started: true });
    expect(onStart).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ error: expect.stringMatching(/^Time limit exceeded/) });
    expect(worker.terminated).toBe(true);
  });

  it("gives up on a runtime that never loads", async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const runner = createCaseRunner({ spawn: () => worker, hardLimitMs: 1_000, startupLimitMs: 10_000 });
    const pending = runner.run("print(1)", undefined, { kind: "stdio", stdin: "" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({ error: expect.stringMatching(/^Python took too long to start/) });
    expect(worker.terminated).toBe(true);
  });

  it("replaces a worker that asks to restart, and warms only once", async () => {
    const workers = [fakeWorker(), fakeWorker()];
    let spawned = 0;
    const runner = createCaseRunner({ spawn: () => workers[spawned++]!, startupLimitMs: 10_000 });
    runner.warm();
    runner.warm();
    expect(spawned).toBe(1);
    expect(workers[0]!.sent).toEqual([expect.objectContaining({ kind: "warm" })]);
    const pending = runner.run("x", undefined, { kind: "stdio", stdin: "" });
    const { id } = workers[0]!.sent[1]!;
    workers[0]!.reply({ id, ok: true, run: { stdout: "", error: "broken" }, restart: true });
    await expect(pending).resolves.toEqual({ stdout: "", error: "broken" });
    expect(workers[0]!.terminated).toBe(true);
    void runner.run("x", undefined, { kind: "stdio", stdin: "" });
    expect(spawned).toBe(2);
  });

  it("terminates an idle, loaded worker that stops answering, and keeps one that answers", async () => {
    vi.useFakeTimers();
    const workers = [fakeWorker(), fakeWorker()];
    let spawned = 0;
    const runner = createCaseRunner({ spawn: () => workers[spawned++]!, hardLimitMs: 3_000, startupLimitMs: 10_000 });
    const pending = runner.run("x", undefined, { kind: "stdio", stdin: "" });
    const { id } = workers[0]!.sent[0]!;
    workers[0]!.reply({ id, started: true });
    workers[0]!.reply({ id, ok: true, run: { stdout: "" } });
    await pending;

    // It answers every ping, so it stays.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      const ping = workers[0]!.sent.at(-1)!;
      expect(ping.kind).toBe("ping");
      workers[0]!.reply({ id: ping.id, pong: true });
    }
    expect(workers[0]!.terminated).toBe(false);

    // Code a case left behind keeps it busy: it stops answering, and is terminated within the hard limit.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(workers[0]!.terminated).toBe(true);
    void runner.run("x", undefined, { kind: "stdio", stdin: "" });
    expect(spawned).toBe(2);
  });

  it("restarts a loaded worker that doesn't start the next case within the hard limit", async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const runner = createCaseRunner({ spawn: () => worker, hardLimitMs: 3_000, startupLimitMs: 60_000 });
    const first = runner.run("x", undefined, { kind: "stdio", stdin: "" });
    worker.reply({ id: worker.sent[0]!.id, started: true });
    worker.reply({ id: worker.sent[0]!.id, ok: true, run: { stdout: "" } });
    await first;
    const next = runner.run("x", undefined, { kind: "stdio", stdin: "" });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(next).resolves.toMatchObject({ error: expect.stringMatching(/still busy with code from an earlier run/) });
    expect(worker.terminated).toBe(true);
  });

  it("reports a crashed worker as the case's error", async () => {
    const worker = fakeWorker();
    const runner = createCaseRunner({ spawn: () => worker });
    const pending = runner.run("x", undefined, { kind: "stdio", stdin: "" });
    worker.crash();
    await expect(pending).resolves.toMatchObject({ error: expect.stringContaining("too much memory") });
    expect(worker.terminated).toBe(true);
  });
});
