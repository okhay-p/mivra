import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../server/src/db/client.js";
import { PortInUseError, listenOnFreePort } from "../../server/src/start.js";
import { makePdf } from "../../server/test/support/files.js";

const bin = fileURLToPath(new URL("../bin/mivra.js", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mivra-cli-"));
  dirs.push(dir);
  return dir;
};
/** The environment a user's shell would have, minus anything that would leak in from this machine's. */
const envFor = (dir: string, extra: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, MIVRA_DATA_DIR: dir, ...extra };
  return env;
};
/** Runs `mivra` to completion. Asynchronous, so the concurrent tests' processes run side by side. */
const run = (dir: string, args: string[], { input, env = {} }: { input?: string; env?: Record<string, string> } = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env: envFor(dir, env), stdio: ["pipe", "pipe", "pipe"], timeout: 90_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {}); // EPIPE when it exits before reading; its exit code tells.
    child.stdin.end(input);
  });
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
const state = (dir: string) => JSON.parse(readFileSync(join(dir, "mivra.pid"), "utf8")) as { pid: number; url: string; port: number };

// Concurrent: nearly all the time here is spent waiting on separate `mivra` processes.
describe.concurrent("mivra", () => {
  it("prints its version and usage", async ({ expect }) => {
    const dir = dataDir();
    expect((await run(dir, ["--version"])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const bogus = await run(dir, ["bogus"]);
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("Unknown command");
    expect(bogus.stderr).toContain("Usage: mivra");
  });

  it("saves, lists and removes keys, from a pipe, in a private file", async ({ expect }) => {
    const dir = dataDir();
    const set = await run(dir, ["auth", "set", "openrouter", "--no-check"], { input: "sk-or-v1-0123456789abcdefWXYZ\n" });
    expect(set.code).toBe(0);
    expect(set.stdout).not.toContain("sk-or-v1");
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect((await run(dir, ["auth", "status"])).stdout).toMatch(/OpenRouter\s+saved, ends in WXYZ/);
    expect((await run(dir, ["auth", "remove", "openrouter"])).stdout).toContain("Removed");
    expect((await run(dir, ["auth", "status"])).stdout).toMatch(/OpenRouter\s+not set/);
    expect((await run(dir, ["auth", "status"])).stdout).toMatch(/ChatGPT\s+not signed in/);
    expect((await run(dir, ["auth", "logout", "chatgpt"])).stdout).toContain("Not signed in to ChatGPT.");
  });

  it("won't save a key the environment overrides, or text that isn't a key", async ({ expect }) => {
    const dir = dataDir();
    const env = await run(dir, ["auth", "set", "openai"], { input: "sk-anything-123456\n", env: { OPENAI_API_KEY: "sk-env-key-123456" } });
    expect(env.code).toBe(1);
    expect(env.stderr).toContain("OPENAI_API_KEY is set");
    const bad = await run(dir, ["auth", "set", "openai", "--no-check"], { input: "not a key\n" });
    expect(bad.code).toBe(1);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
  });

  it("runs in the background, refuses a second copy, serves uploads, and stops", async ({ expect, onTestFinished }) => {
    const dir = dataDir();
    const port = await freePort();
    const start = await run(dir, ["start", "--detach", "--no-open", "--port", String(port)]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain(`http://127.0.0.1:${port}`);
    const { pid, url } = state(dir);
    onTestFinished(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    });
    expect((await run(dir, ["status"])).stdout).toContain(`running at ${url}`);
    expect((await run(dir, ["start", "--detach", "--no-open"])).stdout).toContain("already running");

    // The built UI is served with the token, and a PDF goes through the bundled extraction subprocess.
    expect(await (await fetch(url)).text()).toContain('name="mivra-token"');
    const token = readFileSync(join(dir, "auth-token"), "utf8").trim();
    const headers = { Authorization: `Bearer ${token}` };
    const session = (await (await fetch(`${url}/api/sessions`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(makePdf([["The chain rule composes derivatives."]]))], { type: "application/pdf" }), "notes.pdf");
    const upload = await fetch(`${url}/api/sessions/${session.id}/documents`, { method: "POST", headers, body });
    expect(upload.status, await upload.clone().text()).toBe(201);

    // An Obsidian vault: config and symlinks are left behind, and running it again re-imports.
    const vault = join(dir, "My Vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    mkdirSync(join(vault, "CS"));
    writeFileSync(join(vault, "Recursion.md"), "Calls itself. See [[Stack]]. #cs");
    writeFileSync(join(vault, "CS", "Stack.md"), "LIFO.");
    writeFileSync(join(vault, ".obsidian", "app.md"), "config");
    writeFileSync(join(dir, "outside.md"), "secret outside the vault");
    symlinkSync(join(dir, "outside.md"), join(vault, "Linked.md"));
    const first = await run(dir, ["import", "obsidian", vault]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('Imported "My Vault": 2 added, 0 updated, 0 removed, 0 unchanged. 2 notes in all.');
    writeFileSync(join(vault, "CS", "Stack.md"), "LIFO, used by [[Recursion]].");
    const again = await run(dir, ["import", "obsidian", vault]);
    expect(again.stdout, again.stderr).toContain('Re-imported "My Vault": 0 added, 1 updated, 0 removed, 1 unchanged.');
    const imports = (await (await fetch(`${url}/api/imports`, { headers })).json()) as { id: string }[];
    const graph = (await (await fetch(`${url}/api/imports/${imports[0]!.id}/graph`, { headers })).json()) as { notes: { path: string }[]; links: { to: string | null }[] };
    expect(graph.notes.map((n) => n.path)).toEqual(["CS/Stack.md", "Recursion.md"]);
    expect(graph.links.every((l) => l.to !== null)).toBe(true);
    expect((await run(dir, ["import", "obsidian", join(dir, "missing")])).stderr).toContain("doesn't exist");

    const stop = await run(dir, ["stop"]);
    expect(stop.stdout).toContain("Mivra stopped.");
    expect((await run(dir, ["import", "obsidian", vault])).stderr).toContain("Mivra isn't running.");
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);
    expect((await run(dir, ["status"])).stdout).toContain("isn't running");
    // Many CLI runs, each a new Node process: slow on a loaded machine.
  }, 180_000);

  it("stops cleanly on Ctrl+C in the foreground", async ({ expect, onTestFinished }) => {
    const dir = dataDir();
    const port = await freePort();
    const child = spawn(process.execPath, [bin, "--no-open", "--port", String(port)], { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
    onTestFinished(() => void child.kill("SIGKILL"));
    let stdout = "";
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("Press Ctrl+C")) resolve();
      });
      child.once("exit", () => reject(new Error(`exited early: ${stdout}`)));
    });
    expect(state(dir).port).toBe(port);
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);
  });

  it("exits on Ctrl+C even while background work holds the process", async ({ expect, onTestFinished }) => {
    // Stands in for lesson generation still waiting on a provider: something that keeps Node's event loop busy.
    const busy = `data:text/javascript,${encodeURIComponent("setInterval(() => {}, 1000);")}`;
    const dir = dataDir();
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", busy, bin, "--no-open", "--port", String(port)], { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
    onTestFinished(() => void child.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("Press Ctrl+C")) resolve();
      });
      child.once("exit", () => reject(new Error(`exited early: ${stdout}`)));
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.kill("SIGINT");
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running"), 10_000))]);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);
  });

  it("runs one Mivra per data dir when two start at once", async ({ expect, onTestFinished }) => {
    const dir = dataDir();
    const [a, b] = [await freePort(), await freePort()];
    const launch = (port: number) =>
      new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [bin, "start", "--detach", "--no-open", "--port", String(port)], { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.once("exit", (code) => resolve({ code, stdout }));
      });
    const results = await Promise.all([launch(a), launch(b)]);
    const { pid, url } = state(dir);
    onTestFinished(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    });
    expect(results.map((r) => r.code)).toEqual([0, 0]);
    expect(results.filter((r) => r.stdout.includes("already running"))).toHaveLength(1);
    const answering = async (port: number) => (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false));
    expect([await answering(a), await answering(b)].filter(Boolean)).toHaveLength(1);
    expect([`http://127.0.0.1:${a}`, `http://127.0.0.1:${b}`]).toContain(url);

    expect((await run(dir, ["stop"])).stdout).toContain("Mivra stopped.");
    expect([await answering(a), await answering(b)]).toEqual([false, false]);
  });

  it("refuses a database from a newer Mivra with a clear message", async ({ expect }) => {
    const dir = dataDir();
    const db = openDb(join(dir, "mivra.db"));
    db.$client.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)").run();
    db.$client.close();
    const result = await run(dir, ["--no-open", "--port", String(await freePort())]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("newer version of Mivra");
    expect(result.stderr).not.toContain("    at ");
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);
  });

  it("fails on a taken port it was told to use", async ({ expect, onTestFinished }) => {
    const dir = dataDir();
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    onTestFinished(() => new Promise<void>((r) => blocker.close(() => r())));
    const port = (blocker.address() as { port: number }).port;
    for (const result of [await run(dir, ["--no-open", "--port", String(port)]), await run(dir, ["--no-open"], { env: { MIVRA_PORT: String(port) } })]) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Port ${port} is already in use`);
    }
  });

  it("cleans up after a Mivra that died, and leaves an unknown process alone", async ({ expect }) => {
    const dir = dataDir();
    writeFileSync(join(dir, "mivra.pid"), JSON.stringify({ pid: 2 ** 22 + 12345, port: 1, url: "http://127.0.0.1:1", startedAt: "2026-11-05T00:00:00Z" }));
    expect((await run(dir, ["status"])).stdout).toContain("isn't running");
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);

    // A live pid that doesn't answer as Mivra (here, this test process) is never signalled.
    writeFileSync(join(dir, "mivra.pid"), JSON.stringify({ pid: process.pid, port: 1, url: "http://127.0.0.1:1", startedAt: "2026-11-05T00:00:00Z" }));
    const stop = await run(dir, ["stop"]);
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain("left alone");
  });
});

describe("choosing a port", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  });

  it("moves to the next free port, or fails when it may not", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    servers.push(blocker);
    await new Promise((r) => blocker.once("listening", r));
    const taken = (blocker.address() as { port: number }).port;

    const fallback = createHttpServer();
    servers.push(fallback);
    expect(await listenOnFreePort(fallback, taken, 20)).toBeGreaterThan(taken);

    const strict = createHttpServer();
    await expect(listenOnFreePort(strict, taken, 1)).rejects.toBeInstanceOf(PortInUseError);
  });
});
