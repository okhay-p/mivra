import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/client.js";
import { runs } from "../src/db/schema.js";
import type { ModelSelection } from "../src/model.js";
import { createOpenRouterCatalog, parseOpenRouterModels, staticCatalog, type CatalogModel } from "../src/models/catalog.js";
import { DEFAULT_SELECTION, createModelSettings } from "../src/models/selection.js";
import { loadConfig } from "../src/config.js";
import { replayMessages } from "../src/runtime/turn-runner.js";
import { createSettingsStore } from "../src/store/settings-store.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const replyModel = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t" },
          { type: "text-delta" as const, id: "t", delta: "ok" },
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ],
      }),
    }),
  });

const openRouterEntry = (id: string, extra: object = {}) => ({
  id,
  name: `Vendor: ${id}`,
  context_length: 200000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  supported_parameters: ["tools", "reasoning"],
  reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
  ...extra,
});

describe("OpenRouter's model list", () => {
  it("keeps tool-capable models with their prices and effort levels, and skips the rest", () => {
    const models = parseOpenRouterModels({
      data: [
        openRouterEntry("vendor/thinker"),
        openRouterEntry("vendor/plain", { supported_parameters: ["tools"], reasoning: null, pricing: { prompt: "-1", completion: "-1" } }),
        openRouterEntry("vendor/no-tools", { supported_parameters: ["reasoning"] }),
        openRouterEntry("vendor/thinker:batch"),
        openRouterEntry("vendor/odd-efforts", { reasoning: { supported_efforts: ["turbo", "low"], default_effort: "turbo" } }),
        { id: 42 },
        "not an object",
        openRouterEntry("vendor/thinker"),
      ],
    });
    expect(models).toEqual([
      {
        id: "openrouter:vendor/thinker",
        name: "Vendor: vendor/thinker",
        contextLength: 200000,
        price: { input: 3, output: 15 },
        reasoning: { efforts: ["low", "high", "max"], defaultEffort: "high" },
      },
      { id: "openrouter:vendor/plain", name: "Vendor: vendor/plain", contextLength: 200000, price: null, reasoning: null },
      {
        id: "openrouter:vendor/odd-efforts",
        name: "Vendor: vendor/odd-efforts",
        contextLength: 200000,
        price: { input: 3, output: 15 },
        reasoning: { efforts: ["low"], defaultEffort: null },
      },
    ]);
    expect(() => parseOpenRouterModels({ error: "nope" })).toThrow();
  });

  it("caches for an hour, serves the last good copy when a refresh fails, and survives restarts", async () => {
    let now = 0;
    let fail = false;
    let fetches = 0;
    const fakeFetch: typeof fetch = async () => {
      fetches++;
      if (fail) throw new Error("offline");
      return Response.json({ data: [openRouterEntry("vendor/thinker")] });
    };
    let saved: unknown;
    const persist = { load: () => saved, save: (models: CatalogModel[]) => (saved = models) };
    const catalog = createOpenRouterCatalog({ fetch: fakeFetch, clock: () => now, persist });

    expect((await catalog.list()).state).toBe("fresh");
    await catalog.list();
    expect(fetches).toBe(1);

    now += 60 * 60 * 1000;
    fail = true;
    const stale = await catalog.list();
    expect(stale).toMatchObject({ state: "stale", models: [{ id: "openrouter:vendor/thinker" }] });
    // A failed refresh isn't retried on every request.
    await catalog.list();
    expect(fetches).toBe(2);

    // A restart while offline still has the saved list.
    const restarted = createOpenRouterCatalog({ fetch: fakeFetch, clock: () => now, persist });
    expect(await restarted.list()).toMatchObject({ state: "stale", models: [{ id: "openrouter:vendor/thinker" }] });
    const empty = createOpenRouterCatalog({ fetch: fakeFetch, clock: () => now });
    expect(await empty.list()).toEqual({ models: [], state: "unavailable" });
  });
});

const thinker: CatalogModel = {
  id: "openrouter:vendor/thinker",
  name: "Vendor: Thinker",
  contextLength: 200000,
  price: { input: 3, output: 15 },
  reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "medium" },
};
const plain: CatalogModel = { id: "openrouter:vendor/plain", name: "Vendor: Plain", contextLength: null, price: null, reasoning: null };
const extras: CatalogModel[] = ["a", "b", "c", "d", "e"].map((x) => ({ ...plain, id: `openrouter:vendor/${x}`, name: x }));

function setup(catalog = staticCatalog([thinker, plain, ...extras])) {
  const db = openDb(":memory:");
  const selections: ModelSelection[] = [];
  const llm = replyModel();
  const app = createApp({
    db,
    model: (selection) => {
      selections.push(selection);
      return llm;
    },
    models: { defaults: { model: "anthropic:claude-default", effort: null }, catalog, suggested: [thinker.id, plain.id, "openrouter:vendor/gone"] },
    security: { token: "t", allowedHosts: [] },
  });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers });
  const put = (path: string, body: unknown) => call(path, { method: "PUT", body: JSON.stringify(body) });
  const picker = async () => (await call("/models")).json() as Promise<Record<string, unknown> & { current: ModelSelection; recent: string[]; suggested: string[]; models: CatalogModel[] }>;
  const chat = async () => {
    const session = (await (await call("/sessions", { method: "POST", body: "{}" })).json()) as { id: string };
    const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "hi" }] };
    const stream = await (await call(`/sessions/${session.id}/chat`, { method: "POST", body: JSON.stringify({ message }) })).text();
    return { session, stream };
  };
  return { db, llm, selections, call, put, picker, chat };
}

describe("model picker API", () => {
  it("starts on the configured default, which it lists even when the catalog doesn't", async () => {
    const { picker } = setup();
    const view = await picker();
    expect(view.current).toEqual({ model: "anthropic:claude-default", effort: null });
    expect(view.models.map((m) => m.id)).toEqual(["anthropic:claude-default", thinker.id, plain.id, ...extras.map((m) => m.id)]);
    expect(view.catalog).toBe("fresh");
    // Suggestions missing from the catalog are dropped.
    expect(view.suggested).toEqual([thinker.id, plain.id]);
  });

  it("runs chat with the selected model and effort, and records them on the run and the reply", async () => {
    const { put, chat, llm, selections, db, call } = setup();
    expect((await put("/settings/model", { model: thinker.id, effort: "high" })).status).toBe(200);
    const { session, stream } = await chat();

    expect(selections).toEqual([{ model: thinker.id, effort: "high" }]);
    expect(llm.doStreamCalls[0]?.providerOptions).toEqual({ openrouter: { reasoning: { effort: "high" } } });
    expect(db.select({ model: runs.model, effort: runs.effort }).from(runs).all()).toEqual([{ model: thinker.id, effort: "high" }]);
    expect(stream).toContain(`"messageMetadata":{"model":"${thinker.id}"}`);
    const messages = (await (await call(`/sessions/${session.id}/messages`)).json()) as UIMessage[];
    expect(messages.map((m) => m.metadata)).toEqual([undefined, { model: thinker.id }]);
  });

  it("sends no effort when the selection leaves it to the model", async () => {
    const { put, chat, llm } = setup();
    await put("/settings/model", { model: thinker.id, effort: null });
    await chat();
    expect(llm.doStreamCalls[0]?.providerOptions).toBeUndefined();
  });

  it("rejects models outside the catalog and efforts the model doesn't support", async () => {
    const { put, picker } = setup();
    expect((await put("/settings/model", { model: "openrouter:vendor/unknown", effort: null })).status).toBe(400);
    expect((await put("/settings/model", { model: plain.id, effort: "high" })).status).toBe(400);
    expect((await put("/settings/model", { model: thinker.id, effort: "max" })).status).toBe(400);
    expect((await put("/settings/model", { model: "no-provider", effort: null })).status).toBe(400);
    expect((await picker()).current).toEqual({ model: "anthropic:claude-default", effort: null });
  });

  it("says so when the model list can't be loaded, but still offers the default", async () => {
    const { put, picker } = setup({ list: async () => ({ models: [], state: "unavailable" }) });
    const view = await picker();
    expect(view.catalog).toBe("unavailable");
    expect(view.models.map((m) => m.id)).toEqual(["anthropic:claude-default"]);
    expect((await put("/settings/model", { model: thinker.id, effort: null })).status).toBe(503);
    expect((await put("/settings/model", { model: "anthropic:claude-default", effort: null })).status).toBe(200);
  });

  it("keeps recent and pinned models, and stops suggesting once the learner has enough of their own", async () => {
    const { put, chat, picker } = setup();
    await put("/settings/model", { model: thinker.id, effort: null });
    await chat();
    await put("/settings/model", { model: plain.id, effort: null });
    await chat();
    let view = await picker();
    expect(view.recent).toEqual([plain.id, thinker.id]);
    expect(view.suggested).toEqual([]);

    const pinned = await put("/settings/pinned-models", { models: [extras[0]!.id, extras[1]!.id, extras[0]!.id, "openrouter:vendor/gone"] });
    expect(await pinned.json()).toEqual({ pinned: [extras[0]!.id, extras[1]!.id, "openrouter:vendor/gone"] });
    view = await picker();
    // Pins that left the catalog are hidden.
    expect(view.pinned).toEqual([extras[0]!.id, extras[1]!.id]);
  });
});

describe("the built-in default", () => {
  it("runs a new install on GPT-6 Luna at high effort via OpenRouter until the learner picks a model", async () => {
    const settings = createSettingsStore(openDb(":memory:"));
    const models = createModelSettings({ settings, catalog: staticCatalog([thinker, plain]) });
    expect(models.forRun()).toEqual(DEFAULT_SELECTION);
    expect(DEFAULT_SELECTION.model).toEqual("openrouter:openai/gpt-6-luna");
    expect(DEFAULT_SELECTION.effort).toBe("high");
    // Listed even before the catalog loads, so the picker can always go back to it.
    expect((await models.picker()).models[0]?.id).toBe(DEFAULT_SELECTION.model);
    expect((await models.select({ model: thinker.id, effort: "low" })).ok).toBe(true);
    expect(createModelSettings({ settings, catalog: staticCatalog([thinker]) }).current()).toEqual({ model: thinker.id, effort: "low" });
  });

  it("no longer reads the model from the environment, but says so when it's still set", () => {
    expect(loadConfig({ MIVRA_MODEL: "openrouter:vendor/a", MIVRA_REASONING_EFFORT: "high" }).ignored).toEqual(["MIVRA_MODEL", "MIVRA_REASONING_EFFORT"]);
    expect(loadConfig({}).ignored).toEqual([]);
  });
});

describe("replaying replies after a model switch", () => {
  const reply: UIMessage = {
    id: "r",
    role: "assistant",
    metadata: { model: "openrouter:vendor/a" },
    parts: [
      { type: "step-start", providerMetadata: { openrouter: { reasoning_details: ["SIGNED"] } } } as UIMessage["parts"][number],
      { type: "reasoning", text: "thinking", providerMetadata: { anthropic: { signature: "SIG" } } },
      { type: "text", text: "Answer.", providerMetadata: { openrouter: { private: "X" } } },
      {
        type: "tool-ask_multiple_choice", toolCallId: "c", state: "output-error", input: {}, errorText: "bad",
        callProviderMetadata: { openrouter: { call: "CALLMETA" } }, resultProviderMetadata: { openrouter: { result: "RESULTMETA" } },
      } as unknown as UIMessage["parts"][number],
    ],
  };

  it("gives provider details back only to the model that wrote the reply", async () => {
    const same = JSON.stringify(await replayMessages([reply], "openrouter:vendor/a"));
    expect(same).toContain("SIGNED");
    expect(same).toContain("SIG");
    const other = JSON.stringify(await replayMessages([reply], "openrouter:vendor/b"));
    expect(other).toContain("Answer.");
    expect(other).not.toMatch(/SIGNED|SIG|thinking|private|CALLMETA|RESULTMETA/);
    // A reply from before models were recorded counts as another model's.
    const unrecorded = JSON.stringify(await replayMessages([{ ...reply, metadata: undefined }], "openrouter:vendor/a"));
    expect(unrecorded).not.toMatch(/SIGNED|SIG/);
  });
});
