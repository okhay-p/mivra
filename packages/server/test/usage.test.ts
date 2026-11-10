import { APICallError, simulateReadableStream, stepCountIs, streamText, wrapLanguageModel, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { memoryCredentials } from "../src/credentials.js";
import { openDb } from "../src/db/client.js";
import { messages, sessions, usageRecords } from "../src/db/schema.js";
import { parseOpenRouterModels, type CatalogModel } from "../src/models/catalog.js";
import { createSessionStore } from "../src/store/session-store.js";
import { createUsageStore } from "../src/store/usage-store.js";
import { callTokens, estimateCost, summarise, type UsageRow } from "../src/usage/accounting.js";
import { createUsageTracker } from "../src/usage/tracker.js";
import { createFakeCompatible } from "./support/fake-compatible.js";

// Lessons generate through the whole app, which is slow when the machine is busy.
vi.setConfig({ testTimeout: 30_000 });

type Usage = { inputTokens: Record<string, number | undefined>; outputTokens: Record<string, number | undefined> };
const usage = (input: number, output: number, extra: { cacheRead?: number; cacheWrite?: number; reasoning?: number } = {}): Usage => ({
  inputTokens: { total: input, noCache: input - (extra.cacheRead ?? 0) - (extra.cacheWrite ?? 0), cacheRead: extra.cacheRead, cacheWrite: extra.cacheWrite },
  outputTokens: { total: output, text: output - (extra.reasoning ?? 0), reasoning: extra.reasoning },
});
const finish = (u: Usage, reason: "stop" | "tool-calls" = "stop", providerMetadata?: object) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: u,
  ...(providerMetadata ? { providerMetadata } : {}),
});
const text = (delta: string, u = usage(10, 5), providerMetadata?: object): object[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta },
  { type: "text-end", id: "t" },
  finish(u, "stop", providerMetadata),
];
let callId = 0;
const toolCall = (name: string, input: unknown, u = usage(10, 5)): object[] => [
  { type: "tool-call", toolCallId: `call_${callId++}`, toolName: name, input: JSON.stringify(input) },
  finish(u, "tool-calls"),
];

const row = (over: Partial<UsageRow>): UsageRow => ({
  id: crypto.randomUUID(),
  kind: "chat",
  status: "completed",
  sessionId: "s1",
  runId: "r1",
  provider: "openrouter",
  providerLabel: "OpenRouter",
  model: "openrouter:vendor/a",
  modelLabel: "Vendor: A",
  billing: "api",
  inputTokens: 100,
  inputCacheReadTokens: null,
  inputCacheWriteTokens: null,
  outputTokens: 50,
  outputReasoningTokens: null,
  reportedCost: null,
  estimatedCost: null,
  startedAt: new Date("2026-11-01T12:00:00Z"),
  ...over,
});

describe("usage accounting", () => {
  it("keeps unreported counts unknown, rebuilding a total only from complete parts", () => {
    expect(callTokens(undefined)).toEqual({ input: null, noCache: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null });
    expect(callTokens({ inputTokens: { noCache: 40, cacheRead: 60 }, outputTokens: { text: 7, reasoning: 3 } })).toMatchObject({ input: 100, output: 10 });
    // Without its non-cached part, the input total can't be rebuilt: the cached part alone isn't the total.
    expect(callTokens({ inputTokens: { cacheRead: 60 }, outputTokens: {} })).toMatchObject({ input: null, cacheRead: 60, output: null });
    expect(callTokens({ inputTokens: { total: -1 }, outputTokens: { total: Number.NaN } })).toMatchObject({ input: null, output: null });
  });

  it("prices cached and reasoning tokens once, and gives up rather than guess a cached rate", () => {
    const price = { input: 2, output: 10, cacheRead: 0.5 };
    // 1M input of which 400k cached, 100k output of which 60k reasoning: reasoning is part of the output, priced once.
    const tokens = { input: 1_000_000, noCache: 600_000, cacheRead: 400_000, cacheWrite: null, output: 100_000, reasoning: 60_000 };
    expect(estimateCost(tokens, price)).toBeCloseTo(0.6 * 2 + 0.4 * 0.5 + 0.1 * 10);
    expect(estimateCost(tokens, { input: 2, output: 10 })).toBeNull();
    expect(estimateCost({ ...tokens, cacheRead: 0 }, { input: 2, output: 10 })).toBeCloseTo(1 * 2 + 0.1 * 10);
    expect(estimateCost({ ...tokens, output: null }, price)).toBeNull();
    expect(estimateCost(tokens, null)).toBeNull();
  });

  it("reads cached input rates from OpenRouter's list", () => {
    const [model] = parseOpenRouterModels({
      data: [{ id: "v/m", supported_parameters: ["tools"], pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000005" } }],
    });
    expect(model!.price).toEqual({ input: 2, output: 10, cacheRead: 0.5 });
  });

  it("adds a multi-step run up without double counting, and keeps unknown apart from zero", () => {
    const summary = summarise([
      row({ inputTokens: 100, outputTokens: 50, inputCacheReadTokens: 80, outputReasoningTokens: 20, estimatedCost: 0.01 }),
      row({ inputTokens: 200, outputTokens: 10, inputCacheReadTokens: 150, estimatedCost: 0.02 }),
      // A failed step that reported nothing: unknown, not zero.
      row({ status: "failed", inputTokens: null, outputTokens: null }),
    ]);
    const [run] = summary.runs;
    expect(run).toMatchObject({ calls: 3, incomplete: 1, unreported: 1, input: 300, cacheRead: 230, output: 60, reasoning: 20, total: 360, status: "failed", unknownCost: 1 });
    expect(run!.estimatedCost).toBeCloseTo(0.03);
    expect(summary.totals.cacheWrite).toBeNull();
    // A call that reported zero is zero.
    expect(summarise([row({ inputTokens: 0, outputTokens: 0 })]).totals).toMatchObject({ total: 0, unreported: 0 });
    expect(summarise([]).totals).toMatchObject({ total: null, reportedCost: null, estimatedCost: null, apiEquivalent: null });
  });

  it("keeps API spending, reported and estimated, apart from subscription comparisons", () => {
    const summary = summarise([
      row({ reportedCost: 0.05, estimatedCost: 0.07 }),
      row({ estimatedCost: 0.02 }),
      row({ provider: "chatgpt", model: "chatgpt:x", billing: "subscription", estimatedCost: 0.4 }),
      row({ provider: "chatgpt", model: "chatgpt:y", billing: "subscription", estimatedCost: null }),
    ]);
    // A reported cost wins; its estimate isn't added too.
    expect(summary.api).toMatchObject({ calls: 2, reportedCost: 0.05, apiEquivalent: null, unknownCost: 0 });
    expect(summary.api.estimatedCost).toBeCloseTo(0.02);
    expect(summary.subscription).toMatchObject({ calls: 2, reportedCost: null, estimatedCost: null, apiEquivalent: 0.4, uncompared: 1 });
    expect(summary.totals.estimatedCost).toBeCloseTo(0.02);
    expect(summary.byProvider.map((p) => [p.key, p.billing])).toEqual([["openrouter", "api"], ["chatgpt", "subscription"]]);
  });

  it("buckets days in the learner's time zone", () => {
    const late = row({ startedAt: new Date("2026-11-02T02:00:00Z") });
    expect(summarise([late]).days.map((d) => d.day)).toEqual(["2026-11-02"]);
    // UTC-5 (getTimezoneOffset() = 300): still the evening of the 1st.
    expect(summarise([late], { offsetMinutes: 300 }).days).toEqual([{ day: "2026-11-01", api: 150, subscription: 0, calls: 1 }]);
  });
});

describe("usage tracker", () => {
  const tracked = (doStream: MockLanguageModelV4["doStream"]) => {
    const db = openDb(":memory:");
    const store = createUsageStore(db);
    const tracker = createUsageTracker({
      store,
      describe: async () => ({ price: { input: 1, output: 2, source: "catalog" as const }, modelLabel: "Vendor: M", providerLabel: "OpenRouter" }),
    });
    const model = (runId = "run-1") =>
      wrapLanguageModel({ model: new MockLanguageModelV4({ doStream }), middleware: tracker.middleware({ kind: "chat", selection: { model: "openrouter:vendor/m", effort: null }, runId }) });
    const rows = async () => {
      await tracker.settled();
      return db.select().from(usageRecords).orderBy(usageRecords.seq).all();
    };
    return { model, rows };
  };

  it("records a retried call once per attempt: the failed attempt as unknown, the retry with its usage", async () => {
    let attempts = 0;
    const t = tracked(async () => {
      if (attempts++ === 0) throw new APICallError({ message: "overloaded", url: "https://x.test", requestBodyValues: {}, statusCode: 529, isRetryable: true });
      return { stream: simulateReadableStream({ chunks: text("hi", usage(1000, 500)) as never }) };
    });
    const result = streamText({ model: t.model(), prompt: "PRIVATE prompt", maxRetries: 1 });
    expect(await result.text).toBe("hi");
    const rows = await t.rows();
    expect(rows.map((r) => [r.seq, r.status, r.inputTokens, r.outputTokens])).toEqual([[0, "failed", null, null], [1, "completed", 1000, 500]]);
    expect(rows[0]!.estimatedCost).toBeNull();
    expect(rows[1]!.estimatedCost).toBeCloseTo((1000 * 1 + 500 * 2) / 1e6);
    expect(rows[1]!.price).toEqual({ input: 1, output: 2, source: "catalog" });
    // Content-free: neither the prompt nor the reply is stored.
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|"hi"/);
  });

  it("records a cancelled call as cancelled with unknown usage", async () => {
    const controller = new AbortController();
    const t = tracked(async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: "partial" });
          abortSignal?.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
      }),
    }));
    const result = streamText({ model: t.model(), prompt: "x", abortSignal: controller.signal });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") controller.abort();
    }
    expect((await t.rows()).map((r) => [r.status, r.inputTokens, r.outputTokens])).toEqual([["cancelled", null, null]]);
  });

  it("keeps a call's usage when the provider reports it and then fails", async () => {
    const t = tracked(async () => ({
      stream: simulateReadableStream({ chunks: [...text("x", usage(30, 3)).slice(0, 3), { type: "error", error: new Error("boom") }, finish(usage(30, 3))] as never }),
    }));
    await streamText({ model: t.model(), prompt: "x", onError: () => {} }).consumeStream();
    expect((await t.rows()).map((r) => [r.status, r.inputTokens, r.outputTokens])).toEqual([["failed", 30, 3]]);
  });

  it("numbers each step of a multi-step run", async () => {
    let step = 0;
    const t = tracked(async () => ({
      stream: simulateReadableStream({ chunks: (step++ === 0 ? toolCall("noop", {}, usage(10, 2)) : text("done", usage(20, 4))) as never }),
    }));
    const { tool } = await import("ai");
    const { z } = await import("zod");
    await streamText({
      model: t.model(),
      prompt: "x",
      tools: { noop: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
      stopWhen: stepCountIs(3),
    }).consumeStream();
    expect((await t.rows()).map((r) => [r.runId, r.seq, r.inputTokens, r.outputTokens])).toEqual([["run-1", 0, 10, 2], ["run-1", 1, 20, 4]]);
  });
});

const MODEL: CatalogModel = { id: "openrouter:vendor/main", name: "Vendor: Main", contextLength: 1000, price: { input: 3, output: 15 }, reasoning: null };
const PLAN: CatalogModel = { id: "chatgpt:plan-model", name: "Plan Model", contextLength: 1000, price: null, apiPrice: { input: 2, output: 8 }, reasoning: null };
const UNPRICED: CatalogModel = { id: "openrouter:vendor/unpriced", name: "Vendor: Unpriced", contextLength: 1000, price: null, reasoning: null };

type UsageJson = {
  since: string | null;
  totals: Record<string, number | null>;
  api: Record<string, number | null>;
  subscription: Record<string, number | null>;
  byModel: { key: string; label: string; billing: string; total: number | null }[];
  byKind: { kind: string; calls: number }[];
  sessions: { key: string; label: string; deleted: boolean; calls: number }[];
  runs: { kind: string; session: string | null; calls: number; total: number | null }[];
  prices: { model: string; published: unknown; custom: unknown }[];
};

function setup() {
  const db = openDb(":memory:");
  const listed = { models: [MODEL, PLAN, UNPRICED] };
  /** Chunks per model call, in order; when it runs out, a short reply. */
  const script: object[][] = [];
  const llm = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: (script.shift() ?? text("ok")) as never }) }),
  });
  const compatible = createFakeCompatible({ name: "Local", key: "sk-local-0000LOCL", models: ["local-model"] });
  const app = createApp({
    db,
    model: () => llm,
    models: { defaults: { model: MODEL.id, effort: null }, catalog: { list: async () => ({ models: listed.models, state: "fresh" as const }) } },
    providers: { credentials: memoryCredentials(), isLocal: () => true, custom: { fetch: compatible.fetch } },
    security: { token: "t", allowedHosts: [] },
  });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers });
  const send = async <T>(path: string, method: string, body?: unknown) => {
    const res = await call(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const chat = async (text = "hi", sessionId?: string) => {
    const id = sessionId ?? (await send<{ id: string }>("/sessions", "POST", {})).body.id;
    const message: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
    await (await call(`/sessions/${id}/chat`, { method: "POST", body: JSON.stringify({ message }) })).text();
    return id;
  };
  const view = async () => (await send<UsageJson>("/usage", "GET")).body;
  return { db, listed, script, call, send, chat, view };
}

describe("Usage API", () => {
  it("adds a tutor run's tool-call steps up as one run, with the price known when each call ended", async () => {
    const t = setup();
    t.script.push(toolCall("remember", { kind: "goal", text: "PRIVATE goal" }, usage(1000, 100)), text("PRIVATE reply", usage(1200, 300)));
    const sessionId = await t.chat("PRIVATE question");
    // A later price change doesn't rewrite what was recorded.
    t.listed.models = [{ ...MODEL, price: { input: 100, output: 100 } }, PLAN, UNPRICED];

    const view = await t.view();
    // The session's title is read from the chat when the page asks; usage records keep none.
    expect(view.runs).toEqual([expect.objectContaining({ kind: "chat", calls: 2, input: 2200, output: 400, total: 2600, session: "PRIVATE question" })]);
    expect(view.totals.estimatedCost).toBeCloseTo((2200 * 3 + 400 * 15) / 1e6);
    expect(view.byModel).toEqual([expect.objectContaining({ key: MODEL.id, label: "Vendor: Main", billing: "api", total: 2600 })]);
    expect(view.sessions).toEqual([expect.objectContaining({ key: sessionId, deleted: false, calls: 2 })]);
    expect(view.since).not.toBeNull();
    expect(JSON.stringify(t.db.select().from(usageRecords).all())).not.toMatch(/PRIVATE/);
  });

  it("uses OpenRouter's reported cost, and keeps unpriced calls unknown rather than free", async () => {
    const t = setup();
    t.script.push(text("a", usage(10, 10), { openrouter: { usage: { cost: 0.0123 } } }));
    await t.chat();
    await t.send("/settings/model", "PUT", { model: UNPRICED.id, effort: null });
    await t.chat();
    const { api } = await t.view();
    expect(api).toMatchObject({ calls: 2, reportedCost: 0.0123, estimatedCost: null, unknownCost: 1 });
  });

  it("counts ChatGPT plan calls as subscription usage, compared at API rates but never as spending", async () => {
    const t = setup();
    await t.send("/settings/model", "PUT", { model: PLAN.id, effort: null });
    t.script.push(text("a", usage(1_000_000, 100_000)));
    await t.chat();
    const view = await t.view();
    expect(view.api.calls).toBe(0);
    expect(view.subscription).toMatchObject({ calls: 1, total: 1_100_000, reportedCost: null, estimatedCost: null });
    expect(view.subscription.apiEquivalent).toBeCloseTo(2 + 0.8);
    expect(view.totals.estimatedCost).toBeNull();
  });

  it("applies a custom price to later calls only, and lists models to price", async () => {
    const t = setup();
    await t.send("/settings/model", "PUT", { model: UNPRICED.id, effort: null });
    await t.chat();
    expect((await t.send("/usage/prices", "PUT", { model: UNPRICED.id, price: { input: 1, output: 1 } })).status).toBe(200);
    t.script.push(text("a", usage(1_000_000, 0)));
    await t.chat();
    const view = await t.view();
    expect(view.api).toMatchObject({ calls: 2, estimatedCost: 1, unknownCost: 1 });
    expect(view.prices).toContainEqual(expect.objectContaining({ model: UNPRICED.id, published: null, custom: { input: 1, output: 1 } }));
    expect((await t.send("/usage/prices", "PUT", { model: UNPRICED.id, price: { input: -1, output: 1 } })).status).toBe(400);
    await t.send("/usage/prices", "PUT", { model: UNPRICED.id, price: null });
    expect((await t.view()).prices).toContainEqual(expect.objectContaining({ model: UNPRICED.id, custom: null }));
  });

  it("counts lesson generation as background usage", async () => {
    const t = setup();
    t.script.push(
      toolCall("outline_lesson", { title: "Limits", sections: [{ title: "Intro", kind: "prose", purpose: "Teach it" }] }),
      toolCall("write_lesson_text", { markdown: "A limit." }),
      text(""),
    );
    const store = createSessionStore(t.db);
    const { course } = store.createCourse("Calculus");
    store.writeFirstSyllabus(course.id, null, { topics: [{ title: "Limits", summary: "s", reason: "r", requestedByLearner: false, concepts: ["limit"] }], known: [] });
    const topicId = store.latestSyllabus(course.id)!.topics[0]!.id;
    const lesson = (await t.send<{ lesson: { id: string } }>(`/courses/${course.id}/lessons`, "POST", { topicId })).body.lesson;
    await vi.waitFor(async () => expect((await t.send<{ lesson: { status: string } }>(`/lessons/${lesson.id}`, "GET")).body.lesson.status).not.toBe("generating"), { timeout: 15_000 });
    const view = await t.view();
    expect(view.byKind).toEqual([expect.objectContaining({ kind: "lesson", calls: 3 })]);
    expect(view.runs[0]).toMatchObject({ kind: "lesson", session: "Lesson: Limits" });
  });

  it("counts a custom provider's Test model calls, under the provider's name", async () => {
    const t = setup();
    await t.send("/settings/providers/custom", "POST", { name: "Local", baseUrl: "http://local.test/v1", key: "sk-local-0000LOCL", models: [{ id: "local-model" }] });
    const test = await t.send<{ result: { ok: boolean } }>("/settings/providers/custom/local/test", "POST", { model: "local-model" });
    expect(test.body.result.ok).toBe(true);
    const view = await t.view();
    // The fake reports 12 in and 3 out per call; the test makes the tool call, then continues.
    expect(view.runs).toEqual([expect.objectContaining({ kind: "test", session: null, calls: 2, total: 30, unknownCost: 2 })]);
    expect(view.byModel[0]).toMatchObject({ key: "custom:local/local-model", billing: "api" });
    expect(view.prices).toContainEqual(expect.objectContaining({ model: "custom:local/local-model" }));
  });

  it("keeps records when a chat is deleted, and clears only usage when asked", async () => {
    const t = setup();
    const sessionId = await t.chat();
    // There's no delete route yet; deleting the row is what one will do, and it cascades to runs and messages.
    t.db.delete(sessions).run();
    const view = await t.view();
    expect(view.totals.calls).toBe(1);
    expect(view.sessions).toEqual([expect.objectContaining({ key: sessionId, label: "Deleted chat", deleted: true })]);

    const kept = await t.chat();
    expect((await t.send<{ deleted: number }>("/usage", "DELETE")).body).toEqual({ deleted: 2 });
    expect((await t.view()).totals.calls).toBe(0);
    expect((await t.view()).since).toBeNull();
    expect(t.db.select().from(messages).all().filter((m) => m.sessionId === kept)).toHaveLength(2);
    // Usage counts again from the next call.
    await t.chat("again", kept);
    expect((await t.view()).totals.calls).toBe(1);
  });

  it("filters by start time", async () => {
    const t = setup();
    await t.chat();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await t.send<UsageJson>(`/usage?from=${encodeURIComponent(future)}`, "GET")).body.totals.calls).toBe(0);
    expect((await t.send<UsageJson>(`/usage?from=${encodeURIComponent("2000-01-01T00:00:00.000Z")}`, "GET")).body.totals.calls).toBe(1);
  });
});
