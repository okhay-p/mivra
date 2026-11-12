import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { serveWeb } from "../src/serve-web.js";

const dist = mkdtempSync(join(tmpdir(), "mivra-web-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<html><head></head><body></body></html>");
const script = `console.log(${JSON.stringify("x".repeat(20_000))});`;
writeFileSync(join(dist, "assets", "index-abc123.js"), script);
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

  it("never lets a missing asset or the page with the token be cached", async () => {
    const missing = await app.request("/assets/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBeNull();
    const page = await app.request("/");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain('content="secret-token"');
  });
});
