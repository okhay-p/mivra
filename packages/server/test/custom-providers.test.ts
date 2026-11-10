import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { memoryCredentials, type CredentialStore } from "../src/credentials.js";
import { openDb } from "../src/db/client.js";
import { runs, settings } from "../src/db/schema.js";
import type { ModelSelection } from "../src/model.js";
import { staticCatalog } from "../src/models/catalog.js";
import { parseBaseUrl, parseCustomModelId, parseModelList } from "../src/models/custom-providers.js";
import { replayMessages } from "../src/runtime/turn-runner.js";
import { createFakeCompatible } from "./support/fake-compatible.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const builtIn = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t" },
          { type: "text-delta" as const, id: "t", delta: "built-in reply" },
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ],
      }),
    }),
  });

type View = {
  providers: { id: string; source: string | null }[];
  custom: {
    id: string;
    name: string;
    baseUrl: { value: string | null; source: string | null; env: string | null; error: string | null };
    key: { source: string | null; hint: string | null };
    models: { id: string; modelId: string; contextLength: number | null; maxOutputTokens: number | null; verification: { status: string; message: string | null } }[];
    discovery: { state: string; ids: string[]; error: string | null };
  }[];
};

type Picker = {
  current: ModelSelection;
  models: { id: string; name: string; price: unknown; reasoning: unknown; verification?: string }[];
  providers: { id: string; name: string; removed: boolean }[];
  unavailable: string | null;
};

const KEY_A = "sk-fake-alpha-0000AAAA";
const KEY_B = "sk-fake-bravo-0000BBBB";
const BUILT_IN_KEYS = { openrouter: "sk-or-builtin-1111OR11", openai: "sk-openai-builtin-2222OA22" };

function setup({
  db = openDb(":memory:"),
  env = {} as Record<string, string>,
  // The same environment holds the built-in and custom providers' variables, as in start.ts.
  credentials = memoryCredentials({ saved: { openrouter: BUILT_IN_KEYS.openrouter }, env: { openai: BUILT_IN_KEYS.openai }, vars: env }),
  local = true,
  extraFetch,
}: { db?: ReturnType<typeof openDb>; credentials?: CredentialStore; env?: Record<string, string>; local?: boolean; extraFetch?: typeof fetch } = {}) {
  const alpha = createFakeCompatible({ name: "Alpha", key: KEY_A, models: ["shared-model", "alpha-only"], unknownModels: ["missing"] });
  const bravo = createFakeCompatible({ name: "Bravo", key: KEY_B, models: ["shared-model"] });
  const fakes: Record<string, ReturnType<typeof createFakeCompatible>> = { "alpha.test": alpha, "bravo.test": bravo };
  const routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const fake = fakes[url.host];
    if (fake) return fake.fetch(input, init);
    if (extraFetch) return extraFetch(input, init);
    throw new TypeError("fetch failed", { cause: new Error(`getaddrinfo ENOTFOUND ${url.host}`) });
  }) as typeof fetch;
  const selections: ModelSelection[] = [];
  const llm = builtIn();
  const app = createApp({
    db,
    model: (selection) => {
      selections.push(selection);
      return llm;
    },
    models: {
      defaults: { model: "openrouter:vendor/default", effort: null },
      catalog: staticCatalog([{ id: "openai:shared-model", name: "OpenAI: Shared", contextLength: 1000, price: { input: 1, output: 2 }, reasoning: { efforts: ["high"], defaultEffort: null } }]),
    },
    providers: { credentials, isLocal: () => local, custom: { env: (name) => env[name], fetch: routed } },
    security: { token: "t", allowedHosts: [] },
  });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers });
  const json = async <T>(path: string, method: string, body?: unknown) => {
    const res = await call(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const view = async () => (await json<View>("/settings/providers", "GET")).body;
  const picker = async () => (await json<Picker>("/models", "GET")).body;
  const create = (body: unknown) => json<View & { error?: string }>("/settings/providers/custom", "POST", body);
  const update = (id: string, body: unknown) => json<View & { error?: string }>(`/settings/providers/custom/${id}`, "PUT", body);
  const chat = async (sessionId?: string, text = "hi") => {
    const id = sessionId ?? ((await (await call("/sessions", { method: "POST", body: "{}" })).json()) as { id: string }).id;
    const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
    const res = await call(`/sessions/${id}/chat`, { method: "POST", body: JSON.stringify({ message }) });
    return { sessionId: id, status: res.status, stream: await res.text() };
  };
  return { db, app, alpha, bravo, selections, llm, call, json, view, picker, create, update, chat, credentials };
}

const alphaInput = { name: "Alpha", baseUrl: "https://alpha.test/v1/", key: KEY_A, models: [{ id: "shared-model" }] };

describe("custom provider configuration", () => {
  it("validates base URLs, keeping path prefixes and local servers", () => {
    expect(parseBaseUrl("https://opencode.ai/inference/go/openai/v1/")).toEqual({ ok: true, url: "https://opencode.ai/inference/go/openai/v1" });
    expect(parseBaseUrl("https://api.deepseek.com")).toEqual({ ok: true, url: "https://api.deepseek.com" });
    expect(parseBaseUrl("http://127.0.0.1:11434/v1")).toEqual({ ok: true, url: "http://127.0.0.1:11434/v1" });
    expect(parseBaseUrl("http://localhost:8080")).toEqual({ ok: true, url: "http://localhost:8080" });
    for (const bad of [
      "https://user:pass@api.example.com/v1",
      "https://api.example.com/v1?key=secret",
      "https://api.example.com/v1#frag",
      "https://api.example.com/v1/chat/completions",
      "https://api.example.com/v1/models",
      "ftp://api.example.com",
      "file:///etc/passwd",
      "api.example.com/v1",
      "",
    ]) {
      expect(parseBaseUrl(bad).ok, bad).toBe(false);
    }
  });

  it("parses model lists, skipping bad ids and duplicates", () => {
    expect(parseModelList({ data: [{ id: "a" }, { id: "a" }, { id: "has space" }, { id: 3 }, null, { id: "b/c:free" }] })).toEqual(["a", "b/c:free"]);
    expect(parseModelList([{ id: "bare" }])).toEqual(["bare"]);
    expect(() => parseModelList({ models: [] })).toThrow(/expected format/);
    expect(parseModelList({ data: Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}` })) })).toHaveLength(2000);
  });

  it("names models custom:<provider>/<model>, splitting at the first slash", () => {
    expect(parseCustomModelId("custom:alpha/org/model:free")).toEqual({ providerId: "alpha", modelId: "org/model:free" });
    expect(parseCustomModelId("openai:gpt")).toBeUndefined();
    expect(parseCustomModelId("custom:Bad/x")).toBeUndefined();
  });

  it("saves the configuration in settings and the key in the credential store, and never returns the key", async () => {
    const { create, view, db, credentials, call } = setup();
    const created = await create(alphaInput);
    expect(created.status).toBe(201);
    const alpha = created.body.custom[0]!;
    expect(alpha).toMatchObject({
      id: "alpha",
      name: "Alpha",
      baseUrl: { value: "https://alpha.test/v1", source: "saved", env: null },
      key: { source: "saved", hint: "AAAA" },
      models: [{ id: "shared-model", modelId: "custom:alpha/shared-model", contextLength: null, maxOutputTokens: null, verification: { status: "unverified" } }],
    });
    expect(credentials.customKey("alpha", "UNSET").key).toBe(KEY_A);
    // The key appears in no response and nowhere in the database.
    expect(JSON.stringify(await view())).not.toContain(KEY_A);
    expect(JSON.stringify(db.select().from(settings).all())).not.toContain(KEY_A);
    expect(JSON.stringify(await (await call("/models")).json())).not.toContain(KEY_A);
  });

  it("refuses bad input with a message, and changes from other machines", async () => {
    const { create } = setup();
    for (const [body, message] of [
      [{ ...alphaInput, baseUrl: "https://alpha.test/v1/chat/completions" }, /not the \/chat\/completions endpoint/],
      [{ ...alphaInput, baseUrl: "https://k:secret@alpha.test/v1" }, /user name or password/],
      [{ ...alphaInput, baseUrl: "https://alpha.test/v1?api_key=x" }, /query/],
      [{ ...alphaInput, name: "  " }, /name/],
      [{ ...alphaInput, key: "short" }, /too short/],
      [{ ...alphaInput, models: [{ id: "has space" }] }, /no spaces/],
      [{ ...alphaInput, models: [{ id: "m", contextLength: -1 }] }, /context length/],
    ] as const) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.body as { error: string }).error).toMatch(message);
    }
    expect((await create(alphaInput)).status).toBe(201);
    expect(((await create(alphaInput)).body as { error: string }).error).toMatch(/already a provider called Alpha/);
    const remote = setup({ local: false });
    expect((await remote.create(alphaInput)).status).toBe(403);
  });

  it("survives a restart, keeps ids stable across renames and never reuses a removed provider's id", async () => {
    const db = openDb(":memory:");
    const credentials = memoryCredentials();
    const first = setup({ db, credentials });
    await first.create(alphaInput);
    await first.update("alpha", { name: "Alpha Renamed" });

    const second = setup({ db, credentials });
    const [restored] = (await second.view()).custom;
    expect(restored).toMatchObject({ id: "alpha", name: "Alpha Renamed", key: { source: "saved" }, models: [{ modelId: "custom:alpha/shared-model" }] });
    expect((await second.picker()).models.map((m) => m.id)).toContain("custom:alpha/shared-model");

    expect((await second.json(`/settings/providers/custom/alpha`, "DELETE")).status).toBe(200);
    // The saved key goes with it.
    expect(credentials.customKey("alpha", "UNSET").source).toBeNull();
    const again = await second.create({ ...alphaInput, name: "Alpha" });
    expect(again.body.custom.map((p) => p.id)).toEqual(["alpha-2"]);
    expect((await second.picker()).providers).toEqual([
      { id: "custom:alpha-2", name: "Alpha", removed: false },
      { id: "custom:alpha", name: "Alpha Renamed", removed: true },
    ]);
  });

  it("takes the URL saved in the UI over the environment's, can go back to it, and takes the environment's key first", async () => {
    const env = { MIVRA_PROVIDER_ALPHA_BASE_URL: "https://alpha.test/env/v1", MIVRA_PROVIDER_ALPHA_API_KEY: KEY_A };
    const { create, update, view } = setup({ env });
    const created = await create({ name: "Alpha", models: [{ id: "shared-model" }] });
    expect(created.body.custom[0]).toMatchObject({ baseUrl: { value: "https://alpha.test/env/v1", source: "env", env: "https://alpha.test/env/v1" }, key: { source: "env", hint: "AAAA" } });

    await update("alpha", { baseUrl: "https://alpha.test/v1" });
    expect((await view()).custom[0]!.baseUrl).toMatchObject({ value: "https://alpha.test/v1", source: "saved", env: "https://alpha.test/env/v1" });
    // Reset: back to the environment's URL.
    await update("alpha", { baseUrl: null });
    expect((await view()).custom[0]!.baseUrl).toMatchObject({ value: "https://alpha.test/env/v1", source: "env" });
    // A key from the environment can't be replaced here.
    expect((await update("alpha", { key: KEY_B })).body.error).toMatch(/MIVRA_PROVIDER_ALPHA_API_KEY/);

    // A rejected URL may hold credentials, so it's never sent back: only the reason it isn't used.
    for (const url of ["https://alpha.test/v1?api_key=secret-in-query", "https://user:secret-in-userinfo@alpha.test/v1"]) {
      const bad = setup({ env: { MIVRA_PROVIDER_ALPHA_BASE_URL: url } });
      const shown = await bad.create({ name: "Alpha" });
      expect(shown.body.custom[0]!.baseUrl).toMatchObject({ value: null, source: null, env: null, error: expect.stringMatching(/isn't used/) });
      expect(JSON.stringify(await bad.view())).not.toMatch(/secret-in/);
    }
  });
});

describe("custom provider model lists", () => {
  it("loads <base>/models with only the provider's own key, and keeps manual ids alongside", async () => {
    const { create, json, alpha } = setup();
    await create(alphaInput);
    const refreshed = await json<View>("/settings/providers/custom/alpha/refresh", "POST");
    expect(refreshed.body.custom[0]!.discovery).toMatchObject({ state: "fresh", ids: ["shared-model", "alpha-only"], error: null });
    expect(alpha.requests.at(-1)).toMatchObject({ method: "GET", path: "/v1/models", authorization: `Bearer ${KEY_A}` });
    // Discovered ids are offered, not added: the configured models are unchanged.
    expect(refreshed.body.custom[0]!.models.map((m) => m.id)).toEqual(["shared-model"]);
  });

  it("explains a failed list without blocking manual ids, and keeps the last good list as stale", async () => {
    const { create, json, alpha, update, picker } = setup();
    await create(alphaInput);
    await json("/settings/providers/custom/alpha/refresh", "POST");
    alpha.set({ models: { status: 500 } });
    const stale = (await json<View>("/settings/providers/custom/alpha/refresh", "POST")).body.custom[0]!.discovery;
    expect(stale).toMatchObject({ state: "stale", ids: ["shared-model", "alpha-only"], error: expect.stringMatching(/HTTP 500/) });

    alpha.set({ models: { status: 404 } });
    await update("alpha", { models: [{ id: "shared-model" }, { id: "hand-entered" }] });
    const missing = (await json<View>("/settings/providers/custom/alpha/refresh", "POST")).body.custom[0]!;
    expect(missing.discovery.error).toMatch(/no model list at https:\/\/alpha\.test\/v1\/models.*Enter model ids by hand/);
    expect((await picker()).models.map((m) => m.id)).toEqual(expect.arrayContaining(["custom:alpha/hand-entered"]));

    alpha.set({ models: { raw: "<html>not json</html>" } });
    expect((await json<View>("/settings/providers/custom/alpha/refresh", "POST")).body.custom[0]!.discovery.error).toMatch(/isn't JSON/);
    alpha.set({ models: { raw: JSON.stringify({ data: [{ id: "x".repeat(5 * 1024 * 1024) }] }) } });
    expect((await json<View>("/settings/providers/custom/alpha/refresh", "POST")).body.custom[0]!.discovery.error).toMatch(/too large/);
  });

  it("explains a rejected key without showing it, and forgets lists when the URL or key changes", async () => {
    const { create, json, update } = setup();
    await create({ ...alphaInput, key: "sk-wrong-key-123456789" });
    const failed = (await json<View>("/settings/providers/custom/alpha/refresh", "POST")).body.custom[0]!.discovery;
    expect(failed).toMatchObject({ state: "failed", ids: [] });
    expect(failed.error).toMatch(/rejected the API key/);
    expect(failed.error).not.toContain("sk-wrong-key-123456789");

    await update("alpha", { key: KEY_A });
    expect((await json<View>("/settings/providers/custom/alpha/refresh", "POST")).body.custom[0]!.discovery.state).toBe("fresh");
    await update("alpha", { baseUrl: "https://bravo.test/v1" });
    const moved = (await json<View>("/settings/providers", "GET")).body.custom[0]!;
    expect(moved.discovery).toMatchObject({ state: "none", ids: [] });
  });

  it("doesn't follow a redirect with the key", async () => {
    const seen: string[] = [];
    const target = await listen((req, res) => {
      seen.push(req.headers.authorization ?? "");
      res.end(JSON.stringify({ data: [{ id: "stolen" }] }));
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port(target)}/v1/models` });
      res.end();
    });
    const { create, json, update } = setup({ extraFetch: fetch });
    await create({ ...alphaInput, baseUrl: `http://127.0.0.1:${port(redirector)}/v1` });
    const discovery = (await json<View>("/settings/providers/custom/alpha/refresh", "POST")).body.custom[0]!.discovery;
    expect(discovery.error).toMatch(/redirected/);
    await update("alpha", { models: [{ id: "shared-model" }] });
    const test = await json<{ result: { ok: boolean; message: string } }>("/settings/providers/custom/alpha/test", "POST", { model: "shared-model" });
    expect(test.body.result).toMatchObject({ ok: false, message: expect.stringMatching(/redirect/) });
    expect(seen).toEqual([]);
  });
});

describe("custom provider compatibility test", () => {
  it("passes a model that streams a tool call and continues, and records it for this URL and key only", async () => {
    const { create, json, update, alpha, picker } = setup();
    await create({ ...alphaInput, models: [{ id: "shared-model" }, { id: "no-tools" }, { id: "no-continue" }, { id: "missing" }, { id: "tools-rejected" }, { id: "bad-stream" }] });
    const test = (model: string) => json<{ result: { ok: boolean; reason?: string; message: string }; providers: View }>("/settings/providers/custom/alpha/test", "POST", { model });

    const passed = await test("shared-model");
    expect(passed.body.result.ok).toBe(true);
    expect(passed.body.providers.custom[0]!.models[0]!.verification.status).toBe("verified");
    const calls = alpha.requests.filter((r) => r.path === "/v1/chat/completions");
    // Two streamed calls: the tool call, then the continuation after its result. No reasoning option is sent.
    expect(calls).toHaveLength(2);
    expect(calls.every((r) => r.body?.stream === true && !("reasoning_effort" in r.body))).toBe(true);
    expect((calls[1]!.body!.messages as { role: string }[]).some((m) => m.role === "tool")).toBe(true);
    expect((await picker()).models.find((m) => m.id === "custom:alpha/shared-model")?.verification).toBe("verified");

    expect((await test("no-tools")).body.result).toMatchObject({ ok: false, reason: "tools", message: expect.stringMatching(/without calling the test tool/) });
    expect((await test("no-continue")).body.result).toMatchObject({ ok: false, reason: "tools", message: expect.stringMatching(/didn't continue/) });
    expect((await test("missing")).body.result).toMatchObject({ ok: false, reason: "model", message: expect.stringMatching(/doesn't accept the model “missing”/) });
    expect((await test("tools-rejected")).body.result).toMatchObject({ ok: false, reason: "tools" });
    expect((await test("bad-stream")).body.result.ok).toBe(false);
    const statuses = (await json<View>("/settings/providers", "GET")).body.custom[0]!.models.map((m) => [m.id, m.verification.status]);
    expect(statuses).toEqual([["shared-model", "verified"], ["no-tools", "failed"], ["no-continue", "failed"], ["missing", "failed"], ["tools-rejected", "failed"], ["bad-stream", "failed"]]);

    // A new key is a new configuration: earlier results no longer apply.
    await update("alpha", { key: "sk-another-key-99999999" });
    expect((await json<View>("/settings/providers", "GET")).body.custom[0]!.models[0]!.verification.status).toBe("unverified");
    const rejected = await test("shared-model");
    expect(rejected.body.result).toMatchObject({ ok: false, reason: "auth" });
    // The fake echoes the key it was sent; Mivra doesn't pass it on.
    expect(rejected.body.result.message).not.toContain("sk-another-key-99999999");

    expect((await test("not-configured")).status).toBe(400);
    expect((await json("/settings/providers/custom/nobody/test", "POST", { model: "x" })).status).toBe(404);
  });

  it("explains an unreachable endpoint and a cancelled test, which leaves the earlier result", async () => {
    const { create, app } = setup();
    await create({ ...alphaInput, baseUrl: "https://nowhere.test/v1" });
    const res = await app.request("/api/settings/providers/custom/alpha/test", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "shared-model" }),
    });
    expect(((await res.json()) as { result: { message: string } }).result.message).toMatch(/Couldn't reach nowhere\.test/);

    const slow = setup();
    await slow.create({ ...alphaInput, models: [{ id: "slow" }] });
    const controller = new AbortController();
    const pending = slow.app.request("/api/settings/providers/custom/alpha/test", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "slow" }),
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const result = await Promise.resolve(pending).then((r) => r.json() as Promise<{ result: { reason: string } }>, () => undefined);
    if (result) expect(result.result.reason).toBe("cancelled");
    expect((await slow.view()).custom[0]!.models[0]!.verification.status).toBe("unverified");
  });
});

describe("custom models in the picker and runs", () => {
  it("lists each provider's models under their own ids, beside built-in ones with the same model id", async () => {
    const { create, picker, json } = setup();
    await create(alphaInput);
    await create({ name: "Bravo", baseUrl: "https://bravo.test/v1", key: KEY_B, models: [{ id: "shared-model", contextLength: 64000, maxOutputTokens: 4096 }] });
    const view = await picker();
    const shared = view.models.filter((m) => m.id.endsWith("shared-model")).map((m) => m.id);
    expect(shared).toEqual(["custom:alpha/shared-model", "custom:bravo/shared-model", "openai:shared-model"]);
    expect(view.models.find((m) => m.id === "custom:bravo/shared-model")).toMatchObject({ name: "shared-model", price: null, reasoning: null, verification: "unverified" });
    expect(view.providers.map((p) => p.name)).toEqual(["Alpha", "Bravo"]);

    expect((await json("/settings/model", "PUT", { model: "custom:bravo/shared-model", effort: null })).status).toBe(200);
    // Unconfirmed reasoning controls aren't offered.
    expect((await json("/settings/model", "PUT", { model: "custom:bravo/shared-model", effort: "high" })).status).toBe(400);
  });

  it("sends a custom model's runs to its own endpoint with its own key, and nothing else", async () => {
    const { create, json, chat, alpha, bravo, selections, db } = setup();
    await create(alphaInput);
    await create({ name: "Bravo", baseUrl: "https://bravo.test/v1", key: KEY_B, models: [{ id: "shared-model", maxOutputTokens: 4096 }] });

    await json("/settings/model", "PUT", { model: "custom:bravo/shared-model", effort: null });
    const first = await chat();
    expect(first.stream).toContain("from Bravo (shared-model).");
    expect(alpha.requests).toHaveLength(0);
    const call = bravo.requests.at(-1)!;
    expect(call).toMatchObject({ path: "/v1/chat/completions", authorization: `Bearer ${KEY_B}` });
    expect(call.body).toMatchObject({ model: "shared-model", stream: true, max_tokens: 4096 });
    expect(call.body).not.toHaveProperty("reasoning_effort");

    await json("/settings/model", "PUT", { model: "custom:alpha/shared-model", effort: null });
    expect((await chat(first.sessionId)).stream).toContain("from Alpha (shared-model).");
    // The built-in resolver never saw these runs.
    expect(selections).toEqual([]);

    await json("/settings/model", "PUT", { model: "openai:shared-model", effort: null });
    expect((await chat(first.sessionId)).stream).toContain("built-in reply");
    expect(selections.map((s) => s.model)).toEqual(["openai:shared-model"]);

    // Built-in keys and the other provider's key never reach a custom endpoint.
    const sent = [...alpha.requests, ...bravo.requests].map((r) => r.authorization);
    expect(sent.every((auth) => auth === `Bearer ${KEY_A}` || auth === `Bearer ${KEY_B}`)).toBe(true);
    expect(alpha.requests.every((r) => r.authorization === `Bearer ${KEY_A}`)).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/builtin/);

    const recorded = db.select({ model: runs.model, endpoint: runs.endpoint, status: runs.status }).from(runs).all();
    expect(recorded.map((r) => [r.model, r.status])).toEqual([
      ["custom:bravo/shared-model", "completed"],
      ["custom:alpha/shared-model", "completed"],
      ["openai:shared-model", "completed"],
    ]);
    expect(recorded[0]!.endpoint).toMatch(/^[0-9a-f]{16}$/);
    expect(recorded[0]!.endpoint).not.toBe(recorded[1]!.endpoint);
    expect(recorded[2]!.endpoint).toBeNull();
  });

  it("keeps the key out of logs and runs.error when the provider echoes it back in an error", async () => {
    const echo = (async () =>
      new Response(JSON.stringify({ error: { message: `Invalid API key: ${KEY_A}` } }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { create, json, chat, db } = setup({ extraFetch: echo });
      await create({ name: "Echo", baseUrl: "https://echo.test/v1", key: KEY_A, models: [{ id: "m" }] });
      await json("/settings/model", "PUT", { model: "custom:echo/m", effort: null });
      const reply = await chat();
      expect(reply.stream).not.toContain(KEY_A);
      const recorded = db.select({ status: runs.status, error: runs.error }).from(runs).all();
      expect(recorded).toEqual([{ status: "failed", error: expect.stringContaining("[key]") }]);
      expect(recorded[0]!.error).not.toContain(KEY_A);
      expect(JSON.stringify(logged.mock.calls, (_k, v) => (v instanceof Error ? { message: v.message, body: (v as { responseBody?: string }).responseBody } : v))).not.toContain(KEY_A);

      const tested = await json<{ result: { ok: boolean; message: string } }>("/settings/providers/custom/echo/test", "POST", { model: "m" });
      expect(tested.body.result).toMatchObject({ ok: false, message: expect.stringMatching(/rejected the API key/) });
      expect(tested.body.result.message).not.toContain(KEY_A);
      expect(JSON.stringify(logged.mock.calls, (_k, v) => (v instanceof Error ? { message: v.message, body: (v as { responseBody?: string }).responseBody } : v))).not.toContain(KEY_A);
    } finally {
      logged.mockRestore();
    }
  });

  it("keeps the key out of runs.error when a streamed error event echoes it", async () => {
    const sse = (async () =>
      new Response(`data: ${JSON.stringify({ error: { message: `Invalid API key: ${KEY_A}`, type: "invalid_request_error" } })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { create, json, chat, db } = setup({ extraFetch: sse });
      await create({ name: "Stream", baseUrl: "https://sse.test/v1", key: KEY_A, models: [{ id: "m" }] });
      await json("/settings/model", "PUT", { model: "custom:stream/m", effort: null });
      const reply = await chat();
      expect(reply.stream).not.toContain(KEY_A);
      const recorded = db.select({ status: runs.status, error: runs.error }).from(runs).all();
      expect(recorded).toEqual([{ status: "failed", error: expect.any(String) }]);
      expect(recorded[0]!.error).not.toContain(KEY_A);
      expect(JSON.stringify(logged.mock.calls, (_k, v) => (v instanceof Error ? { message: v.message } : v))).not.toContain(KEY_A);
    } finally {
      logged.mockRestore();
    }
  });

  it("records a new endpoint after the URL changes, so earlier reasoning metadata isn't replayed there", async () => {
    const { create, update, json, chat, db } = setup();
    await create(alphaInput);
    await json("/settings/model", "PUT", { model: "custom:alpha/shared-model", effort: null });
    const { sessionId } = await chat();
    await update("alpha", { baseUrl: "https://alpha.test/v2" });
    await chat(sessionId);
    const [before, after] = db.select({ endpoint: runs.endpoint }).from(runs).all();
    expect(before!.endpoint).not.toBe(after!.endpoint);

    const reply = (endpoint: string): UIMessage => ({
      id: "a",
      role: "assistant",
      metadata: { model: "custom:alpha/shared-model", endpoint },
      parts: [
        { type: "step-start", providerMetadata: { custom: { signature: "PRIVATE" } } } as UIMessage["parts"][number],
        { type: "reasoning", text: "thinking", state: "done", providerMetadata: { custom: { signature: "PRIVATE" } } },
        { type: "text", text: "answer" },
      ],
    });
    const same = JSON.stringify(await replayMessages([reply(before!.endpoint!)], "custom:alpha/shared-model", before!.endpoint!));
    const moved = JSON.stringify(await replayMessages([reply(before!.endpoint!)], "custom:alpha/shared-model", after!.endpoint!));
    expect(same).toContain("PRIVATE");
    expect(moved).not.toContain("PRIVATE");
    expect(moved).toContain("answer");
  });

  it("asks the learner to choose again when the selected provider is removed, without rerouting, and keeps old replies labelled", async () => {
    const { create, json, chat, picker, selections, call } = setup();
    await create(alphaInput);
    await json("/settings/model", "PUT", { model: "custom:alpha/shared-model", effort: null });
    const { sessionId } = await chat();
    expect((await picker()).unavailable).toBeNull();

    await json("/settings/providers/custom/alpha", "DELETE");
    const view = await picker();
    expect(view.current.model).toBe("custom:alpha/shared-model");
    expect(view.unavailable).toMatch(/The provider Alpha was removed\. Choose another model/);
    expect(view.models.some((m) => m.id.startsWith("custom:"))).toBe(false);
    expect(view.providers).toEqual([{ id: "custom:alpha", name: "Alpha", removed: true }]);

    const failed = await chat(sessionId);
    expect(failed.status).toBe(500);
    expect(failed.stream).toMatch(/The provider Alpha was removed/);
    expect(selections).toEqual([]);

    const messages = (await (await call(`/sessions/${sessionId}/messages`)).json()) as UIMessage[];
    const reply = messages.find((m) => m.role === "assistant")!;
    // The reply stays readable and names its model; the endpoint fingerprint stays on the server.
    expect(reply.metadata).toEqual({ model: "custom:alpha/shared-model" });
    expect(JSON.stringify(reply.parts)).toContain("Hello from Alpha");
  });

  it("asks again when the selected model is taken off its provider", async () => {
    const { create, json, update, picker } = setup();
    await create({ ...alphaInput, models: [{ id: "shared-model" }, { id: "alpha-only" }] });
    await json("/settings/model", "PUT", { model: "custom:alpha/alpha-only", effort: null });
    await update("alpha", { models: [{ id: "shared-model" }] });
    expect((await picker()).unavailable).toMatch(/alpha-only isn't one of Alpha's models any more/);
  });
});

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const port = (server: Server) => (server.address() as AddressInfo).port;
async function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
