import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CREDENTIALS_FILE, createCredentialStore, memoryCredentials, type CredentialStore, type ProviderId } from "../src/credentials.js";
import { openDb } from "../src/db/client.js";
import { createKeyedCatalog, staticCatalog } from "../src/models/catalog.js";
import { checkProviderKey, type KeyCheck } from "../src/models/key-check.js";

const TOKEN = "test-token";
const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };
const KEY = "sk-or-v1-0123456789abcdefWXYZ";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mivra-credentials-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the credentials file", () => {
  it("saves keys with mode 0600 and reads them back", () => {
    const dataDir = tempDir();
    const store = createCredentialStore({ dataDir, env: {} });
    expect(store.set("openrouter", `  ${KEY}\n`)).toEqual({ ok: true });
    expect(store.keys()).toEqual({ openrouter: KEY });
    const path = join(dataDir, CREDENTIALS_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ keys: { openrouter: KEY } });
  });

  it("prefers the environment's key and won't change or remove it", () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, CREDENTIALS_FILE), JSON.stringify({ keys: { openrouter: "saved-key-123456" } }));
    const store = createCredentialStore({ dataDir, env: { OPENROUTER_API_KEY: KEY } });
    expect(store.keys()).toEqual({ openrouter: KEY });
    expect(store.set("openrouter", "another-key-123456")).toEqual({ ok: false, reason: "env" });
    expect(store.remove("openrouter")).toBe("env");
    expect(store.views()[0]).toEqual({ id: "openrouter", label: "OpenRouter", source: "env", hint: "WXYZ" });
  });

  it("picks up a key another process saved, without restarting", () => {
    const dataDir = tempDir();
    const server = createCredentialStore({ dataDir, env: {} });
    expect(server.keys()).toEqual({});
    createCredentialStore({ dataDir, env: {} }).set("anthropic", KEY);
    expect(server.keys()).toEqual({ anthropic: KEY });
  });

  it("ignores a broken file instead of failing", () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, CREDENTIALS_FILE), "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createCredentialStore({ dataDir, env: {} });
    expect(store.keys()).toEqual({});
    expect(store.keys()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("removes a saved key and keeps the others", () => {
    const store = createCredentialStore({ dataDir: tempDir(), env: {} });
    store.set("openrouter", KEY);
    store.set("openai", "sk-openai-key-0000");
    expect(store.remove("openrouter")).toBe(true);
    expect(store.remove("openrouter")).toBe(false);
    expect(store.keys()).toEqual({ openai: "sk-openai-key-0000" });
  });

  it("refuses text that can't be a key", () => {
    const store = memoryCredentials();
    expect(() => store.set("openai", "short")).toThrow();
    expect(() => store.set("openai", "has a space in it")).toThrow();
  });
});

function setup(credentials: CredentialStore, { local = true, check = vi.fn(async (): Promise<KeyCheck> => ({ ok: true })) }: { local?: boolean; check?: (provider: ProviderId, key: string) => Promise<KeyCheck> } = {}) {
  const app = createApp({
    db: openDb(":memory:"),
    model: () => new MockLanguageModelV4(),
    security: { token: TOKEN, allowedHosts: ["prestige.example.ts.net"] },
    providers: { credentials, check, isLocal: () => local },
  });
  return { app, check };
}

describe("provider key routes", () => {
  it("never return a key, only where it comes from and its last four characters", async () => {
    const { app } = setup(memoryCredentials({ env: { openai: "sk-env-key-1234abcd" }, saved: { openrouter: KEY } }));
    const res = await app.request("/api/settings/providers", { headers: auth });
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("sk-env-key");
    expect(JSON.parse(text)).toEqual({
      canEdit: true,
      chatgpt: null,
      custom: [],
      providers: [
        { id: "openrouter", label: "OpenRouter", source: "saved", hint: "WXYZ" },
        { id: "anthropic", label: "Anthropic", source: null, hint: null },
        { id: "openai", label: "OpenAI", source: "env", hint: "abcd" },
      ],
    });
  });

  it("save and remove a key from this machine", async () => {
    const credentials = memoryCredentials();
    const { app } = setup(credentials);
    const saved = await app.request("/api/settings/providers/openrouter", { method: "PUT", headers: json, body: JSON.stringify({ key: KEY }) });
    expect(saved.status).toBe(200);
    expect((await saved.json()).providers[0]).toEqual({ id: "openrouter", label: "OpenRouter", source: "saved", hint: "WXYZ" });
    expect(credentials.keys()).toEqual({ openrouter: KEY });

    expect((await app.request("/api/settings/providers/openrouter", { method: "DELETE", headers: auth })).status).toBe(200);
    expect(credentials.keys()).toEqual({});
    expect((await app.request("/api/settings/providers/openrouter", { method: "DELETE", headers: auth })).status).toBe(404);
  });

  it("refuse changes from another machine, but still show the status", async () => {
    const credentials = memoryCredentials({ saved: { openrouter: KEY } });
    const { app } = setup(credentials, { local: false });
    const list = await app.request("http://prestige.example.ts.net/api/settings/providers", { headers: auth });
    expect((await list.json()).canEdit).toBe(false);
    const put = await app.request("http://prestige.example.ts.net/api/settings/providers/anthropic", { method: "PUT", headers: json, body: JSON.stringify({ key: KEY }) });
    expect(put.status).toBe(403);
    const del = await app.request("http://prestige.example.ts.net/api/settings/providers/openrouter", { method: "DELETE", headers: auth });
    expect(del.status).toBe(403);
    expect(credentials.keys()).toEqual({ openrouter: KEY });
  });

  it("refuse an invalid key, an environment key and an unknown provider", async () => {
    const { app } = setup(memoryCredentials({ env: { openai: KEY } }));
    const put = (provider: string, key: string) =>
      app.request(`/api/settings/providers/${provider}`, { method: "PUT", headers: json, body: JSON.stringify({ key }) });
    expect((await put("openrouter", "nope")).status).toBe(400);
    expect((await put("openai", KEY)).status).toBe(409);
    expect((await put("mistral", KEY)).status).toBe(400);
    expect((await app.request("/api/settings/providers/openai", { method: "DELETE", headers: auth })).status).toBe(409);
  });

  it("check the key in use with the provider", async () => {
    const check = vi.fn(async () => ({ ok: false as const, reason: "rejected" as const, message: "The provider rejected this key." }));
    const { app } = setup(memoryCredentials({ saved: { anthropic: KEY } }), { check });
    const res = await app.request("/api/settings/providers/anthropic/check", { method: "POST", headers: auth });
    expect(await res.json()).toEqual({ ok: false, reason: "rejected", message: "The provider rejected this key." });
    expect(check).toHaveBeenCalledWith("anthropic", KEY);
    expect((await app.request("/api/settings/providers/openai/check", { method: "POST", headers: auth })).status).toBe(404);
  });

  it("need the API token", async () => {
    const { app } = setup(memoryCredentials());
    expect((await app.request("/api/settings/providers")).status).toBe(401);
  });
});

describe("the loopback rule", () => {
  it("lets a client on this machine change keys over a real socket", async () => {
    const app = createApp({
      db: openDb(":memory:"),
      model: () => new MockLanguageModelV4(),
      security: { token: TOKEN, allowedHosts: ["prestige.example.ts.net"] },
      providers: { credentials: memoryCredentials() },
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      // node:http, since fetch won't send a Host header of its own.
      const canEdit = (headers: Record<string, string> = {}) =>
        new Promise<boolean>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path: "/api/settings/providers", headers: { ...auth, ...headers } }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve(JSON.parse(body).canEdit));
          });
          req.on("error", reject);
          req.end();
        });
      expect(await canEdit()).toBe(true);
      // A proxy on this machine (`tailscale serve`) connects from loopback for other devices: its Host or
      // forwarding headers give it away.
      expect(await canEdit({ host: "prestige.example.ts.net" })).toBe(false);
      expect(await canEdit({ "x-forwarded-for": "100.64.0.7" })).toBe(false);
      expect(await canEdit({ forwarded: "for=100.64.0.7" })).toBe(false);
      // A Host header claiming localhost doesn't make an in-process request local.
      const spoofed = await app.request("http://localhost/api/settings/providers", { headers: auth });
      expect((await spoofed.json()).canEdit).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("the model list follows the keys", () => {
  it("rebuilds the catalog only when a key changes", async () => {
    const credentials = memoryCredentials();
    const build = vi.fn((keys: object) => staticCatalog(Object.keys(keys).map((id) => ({ id: `${id}:m`, name: id, contextLength: null, price: null, reasoning: null }))));
    const catalog = createKeyedCatalog(credentials.keys, build);
    expect((await catalog.list()).models).toEqual([]);
    await catalog.list();
    expect(build).toHaveBeenCalledTimes(1);
    credentials.set("openai", KEY);
    expect((await catalog.list()).models.map((m) => m.id)).toEqual(["openai:m"]);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("checking a key with the provider", () => {
  const respond = (status: number) => vi.fn(async () => new Response("{}", { status }));

  it("asks OpenRouter's key endpoint with the key", async () => {
    const fetch = respond(200);
    expect(await checkProviderKey("openrouter", KEY, { fetch })).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({ headers: { authorization: `Bearer ${KEY}` } }));
  });

  it("uses the configured base URL for a direct provider", async () => {
    const fetch = respond(200);
    await checkProviderKey("anthropic", KEY, { fetch, baseUrl: "http://proxy.local/v1/" });
    expect(fetch).toHaveBeenCalledWith("http://proxy.local/v1/models?limit=1", expect.anything());
  });

  it("tells a rejected key from a provider it couldn't reach", async () => {
    expect(await checkProviderKey("openai", KEY, { fetch: respond(401) })).toMatchObject({ ok: false, reason: "rejected" });
    expect(await checkProviderKey("openai", KEY, { fetch: respond(503) })).toMatchObject({ ok: false, reason: "unreachable" });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await checkProviderKey("openai", KEY, { fetch: offline })).toMatchObject({ ok: false, reason: "unreachable" });
  });
});
