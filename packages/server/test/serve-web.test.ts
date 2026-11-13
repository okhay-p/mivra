import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { EXERCISE_WORKER_CSP, pyodideAssets, serveWeb } from "../src/serve-web.js";

const dist = mkdtempSync(join(tmpdir(), "mivra-web-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<html><head></head><body></body></html>");
const script = `console.log(${JSON.stringify("x".repeat(20_000))});`;
writeFileSync(join(dist, "assets", "index-abc123.js"), script);
mkdirSync(join(dist, "assets", "exercise-workers"));
writeFileSync(join(dist, "assets", "exercise-workers", "python-exercise.worker-abc.js"), "self.onmessage = () => {};");
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const app = new Hono();
serveWeb(app, dist, "secret-token");

describe("serveWeb", () => {
  it("gzips hashed assets and lets the browser keep them", async () => {
    const res = await app.request("/assets/index-abc123.js", { headers: { "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBeLessThan(script.length / 10);
    expect(gunzipSync(body).toString()).toBe(script);
  });

  it("sends assets uncompressed to a client that doesn't accept gzip", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(script);
  });

  it("sends exercise workers with a CSP that forbids running strings and other origins", async () => {
    const worker = await app.request("/assets/exercise-workers/python-exercise.worker-abc.js");
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-security-policy")).toBe(EXERCISE_WORKER_CSP);
    expect(EXERCISE_WORKER_CSP).not.toMatch(/[ ]'unsafe-eval'/);
    expect((await app.request("/assets/index-abc123.js")).headers.get("content-security-policy")).toBeNull();
  });

  it("serves Pyodide's runtime files from the server's own dependency, and nothing else from it", async () => {
    const { base } = pyodideAssets();
    expect(base).toMatch(/^\/assets\/pyodide-\d+\.\d+\.\d+\/$/);
    const wasm = await app.request(`${base}pyodide.asm.wasm`, { headers: { "accept-encoding": "gzip" } });
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await app.request(`${base}pyodide.mjs`)).headers.get("content-type")).toMatch(/javascript/);
    for (const other of ["package.json", "pyodide.d.ts", "README.md", "..%2Fpackage.json"]) expect((await app.request(`${base}${other}`)).status).toBe(404);
  });

  it("never lets a missing asset or the page with the token be cached", async () => {
    const missing = await app.request("/assets/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBeNull();
    const page = await app.request("/");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain('content="secret-token"');
  });
});
