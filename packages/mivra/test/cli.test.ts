import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
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
const run = (dir: string, args: string[], { input, env = {} }: { input?: string; env?: Record<string, string> } = {}) => {
  const result = spawnSync(process.execPath, [bin, ...args], { env: envFor(dir, env), input, encoding: "utf8", timeout: 90_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
const state = (dir: string) => JSON.parse(readFileSync(join(dir, "mivra.pid"), "utf8")) as { pid: number; url: string; port: number };

describe("mivra", () => {
  it("prints its version and usage", () => {
    const dir = dataDir();
    expect(run(dir, ["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const bogus = run(dir, ["bogus"]);
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("Unknown command");
    expect(bogus.stderr).toContain("Usage: mivra");
  });

  it("saves, lists and removes keys, from a pipe, in a private file", () => {
    const dir = dataDir();
    const set = run(dir, ["auth", "set", "openrouter", "--no-check"], { input: "sk-or-v1-0123456789abcdefWXYZ\n" });
    expect(set.code).toBe(0);
    expect(set.stdout).not.toContain("sk-or-v1");
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(run(dir, ["auth", "status"]).stdout).toMatch(/OpenRouter\s+saved, ends in WXYZ/);
    expect(run(dir, ["auth", "remove", "openrouter"]).stdout).toContain("Removed");
    expect(run(dir, ["auth", "status"]).stdout).toMatch(/OpenRouter\s+not set/);
  });

  it("won't save a key the environment overrides, or text that isn't a key", () => {
    const dir = dataDir();
    const env = run(dir, ["auth", "set", "openai"], { input: "sk-anything-123456\n", env: { OPENAI_API_KEY: "sk-env-key-123456" } });
    expect(env.code).toBe(1);
    expect(env.stderr).toContain("OPENAI_API_KEY is set");
    const bad = run(dir, ["auth", "set", "openai", "--no-check"], { input: "not a key\n" });
    expect(bad.code).toBe(1);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
  });

  it("runs in the background, refuses a second copy, serves uploads, and stops", async () => {
    const dir = dataDir();
    const port = await freePort();
    const start = run(dir, ["start", "--detach", "--no-open", "--port", String(port)]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain(`http://127.0.0.1:${port}`);
    const { pid, url } = state(dir);
    cleanups.push(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    });
    expect(run(dir, ["status"]).stdout).toContain(`running at ${url}`);
    expect(run(dir, ["start", "--detach", "--no-open"]).stdout).toContain("already running");

    // The built UI is served with the token, and a PDF goes through the bundled extraction subprocess.
    expect(await (await fetch(url)).text()).toContain('name="mivra-token"');
    const token = readFileSync(join(dir, "auth-token"), "utf8").trim();
    const headers = { Authorization: `Bearer ${token}` };
    const session = (await (await fetch(`${url}/api/sessions`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(makePdf([["The chain rule composes derivatives."]]))], { type: "application/pdf" }), "notes.pdf");
    const upload = await fetch(`${url}/api/sessions/${session.id}/documents`, { method: "POST", headers, body });
    expect(upload.status, await upload.clone().text()).toBe(201);

    const stop = run(dir, ["stop"]);
    expect(stop.stdout).toContain("Mivra stopped.");
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);
    expect(run(dir, ["status"]).stdout).toContain("isn't running");
  });

  it("stops cleanly on Ctrl+C in the foreground", async () => {
    const dir = dataDir();
    const port = await freePort();
    const child = spawn(process.execPath, [bin, "--no-open", "--port", String(port)], { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => void child.kill("SIGKILL"));
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

  it("exits on Ctrl+C even while background work holds the process", async () => {
    // Stands in for lesson generation still waiting on a provider: something that keeps Node's event loop busy.
    const busy = `data:text/javascript,${encodeURIComponent("setInterval(() => {}, 1000);")}`;
    const dir = dataDir();
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", busy, bin, "--no-open", "--port", String(port)], { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => void child.kill("SIGKILL"));
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

  it("runs one Mivra per data dir when two start at once", async () => {
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
    cleanups.push(() => {
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

    expect(run(dir, ["stop"]).stdout).toContain("Mivra stopped.");
    expect([await answering(a), await answering(b)]).toEqual([false, false]);
  });

  it("refuses a database from a newer Mivra with a clear message", async () => {
    const dir = dataDir();
    const db = openDb(join(dir, "mivra.db"));
    db.$client.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)").run();
    db.$client.close();
    const result = run(dir, ["--no-open", "--port", String(await freePort())]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("newer version of Mivra");
    expect(result.stderr).not.toContain("    at ");
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);
  });

  it("fails on a taken port it was told to use", async () => {
    const dir = dataDir();
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const port = (blocker.address() as { port: number }).port;
    for (const result of [run(dir, ["--no-open", "--port", String(port)]), run(dir, ["--no-open"], { env: { MIVRA_PORT: String(port) } })]) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Port ${port} is already in use`);
    }
  });

  it("cleans up after a Mivra that died, and leaves an unknown process alone", () => {
    const dir = dataDir();
    writeFileSync(join(dir, "mivra.pid"), JSON.stringify({ pid: 2 ** 22 + 12345, port: 1, url: "http://127.0.0.1:1", startedAt: "2026-11-05T00:00:00Z" }));
    expect(run(dir, ["status"]).stdout).toContain("isn't running");
    expect(existsSync(join(dir, "mivra.pid"))).toBe(false);

    // A live pid that doesn't answer as Mivra (here, this test process) is never signalled.
    writeFileSync(join(dir, "mivra.pid"), JSON.stringify({ pid: process.pid, port: 1, url: "http://127.0.0.1:1", startedAt: "2026-11-05T00:00:00Z" }));
    const stop = run(dir, ["stop"]);
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
