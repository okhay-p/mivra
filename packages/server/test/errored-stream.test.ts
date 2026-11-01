import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const auth = { authorization: "Bearer t", "content-type": "application/json" };

it.each(["mid-reply", "after-tool"])("survives a model stream error %s over real HTTP, fails the run and accepts the next turn", async (scenario) => {
  const child = spawn(process.execPath, [
    "--unhandled-rejections=strict", "--conditions=@mivra/source",
    "--import", createRequire(import.meta.url).resolve("tsx"),
    fileURLToPath(new URL("./support/errored-stream-server.ts", import.meta.url)), scenario,
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  let base = "";
  child.stderr!.on("data", (data) => (stderr += data));
  try {
    const [{ port }] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => { throw new Error(`Server exited before startup: ${stderr}`); }),
    ]) as [{ port: number }];
    base = `http://127.0.0.1:${port}`;
    const session = await (await fetch(`${base}/api/sessions`, { method: "POST", headers: auth, body: "{}" })).json() as { id: string };
    const send = (text = "hello", signal?: AbortSignal) => fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: "POST", headers: auth, signal,
      body: JSON.stringify({ message: { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] } }),
    });
    const response = await send();
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let sse = "";
    while (!sse.includes("Partial reply")) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      sse += decoder.decode(value);
    }
    if (scenario === "after-tool") {
      const state = await (await fetch(`${base}/test-state`)).json() as { memories: unknown[] };
      expect(state.memories).toEqual([{ status: "pending" }]);
    }
    child.send({ error: true });
    // The response must close normally, including the SSE terminator, rather than reject or kill Node.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += decoder.decode(value);
    }
    expect(sse).toContain('"errorText":"The model request failed (HTTP 200)."');
    expect(sse).toContain("data: [DONE]");
    expect(sse).not.toMatch(/PRIVATE|prematurely|remember/);
    const state = await (await fetch(`${base}/test-state`)).json() as { runs: { status: string; error: string }[]; memories: unknown[] };
    expect(state.runs).toEqual([{ status: "failed", error: "Failed to process successful response" }]);
    expect(state.memories).toEqual([]);
    expect(await (await send("recover")).text()).toContain("Recovered reply");
    await vi.waitFor(async () => {
      const next = await (await fetch(`${base}/test-state`)).json() as { runs: { status: string }[] };
      expect(next.runs.map((run) => run.status)).toEqual(["failed", "completed"]);
    });
    // Both Stop (fetch abort) and a disconnected response reader must keep cancellation semantics,
    // even when the provider errors its source in response to the abort signal.
    const abort = new AbortController();
    const stopped = await send("hold", abort.signal);
    const stoppedReader = stopped.body!.getReader();
    let partial = "";
    while (!partial.includes("Partial reply")) {
      const { done, value } = await stoppedReader.read();
      expect(done).toBe(false);
      partial += decoder.decode(value);
    }
    if (scenario === "mid-reply") abort.abort();
    await stoppedReader.cancel().catch(() => {});
    await vi.waitFor(async () => {
      const cancelled = await (await fetch(`${base}/test-state`)).json() as { runs: { status: string }[] };
      expect(cancelled.runs.map((run) => run.status)).toEqual(["failed", "completed", "cancelled"]);
    });
    expect(await (await send("recover")).text()).toContain("Recovered reply");
    const history = await (await fetch(`${base}/api/sessions/${session.id}/messages`, { headers: auth })).text();
    expect(history).not.toContain("Partial reply");
    expect(child.exitCode, stderr).toBeNull();
    expect(stderr).toBe("");
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = await fetch(`${base}/test-state`).then((r) => r.text()).catch(String);
    throw new Error(`HTTP regression failed; state: ${state}; child exit: ${child.exitCode}; stderr: ${stderr}`, { cause: error });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
}, 30_000);
