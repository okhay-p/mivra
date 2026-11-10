import type { ModelPrice } from "../models/catalog.js";

/**
 * Usage accounting (issue #70): what one model call reported, what it may have cost, and how calls add up. Pure
 * functions only, so the rules (unknown is never zero, cached and reasoning tokens are parts of input and output and
 * are never added again) are tested without a database.
 */

export const usageKindList = ["chat", "continuation", "lesson", "distillation", "test"] as const;
export type UsageKind = (typeof usageKindList)[number];
export type UsageStatus = "completed" | "failed" | "cancelled";
/** `api`: billed per token to an API key. `subscription`: the learner's ChatGPT plan pays (ADR-015). */
export type Billing = "api" | "subscription";

/** A price as it was when a call ended, and where it came from. */
export interface PriceSnapshot extends ModelPrice {
  /** `catalog`: the model list's published price (OpenRouter's). `custom`: the learner's own, set under Advanced. */
  source: "catalog" | "custom";
}

/** Token counts for one call; null means the provider didn't report it, which is never the same as zero. */
export interface CallTokens {
  /** Every input token, cached ones included. */
  input: number | null;
  noCache: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Every output token, reasoning included. */
  output: number | null;
  reasoning: number | null;
}

/** The usage on a model call's finish part, in the AI SDK's provider (v4) shape. Any field may be missing. */
export interface ProviderUsage {
  inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number; text?: number; reasoning?: number };
}

export const NO_TOKENS: CallTokens = { input: null, noCache: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null };

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/**
 * The AI SDK's usage for one call, as stored. A total the provider left out is rebuilt from its parts only when the
 * parts that make it up were all reported; otherwise it stays unknown.
 */
export function callTokens(usage: ProviderUsage | undefined): CallTokens {
  if (!usage) return NO_TOKENS;
  const noCache = count(usage.inputTokens?.noCache);
  const cacheRead = count(usage.inputTokens?.cacheRead);
  const cacheWrite = count(usage.inputTokens?.cacheWrite);
  const text = count(usage.outputTokens?.text);
  const reasoning = count(usage.outputTokens?.reasoning);
  const input = count(usage.inputTokens?.total) ?? (noCache !== null ? noCache + (cacheRead ?? 0) + (cacheWrite ?? 0) : null);
  const output = count(usage.outputTokens?.total) ?? (text !== null ? text + (reasoning ?? 0) : null);
  return { input, noCache, cacheRead, cacheWrite, output, reasoning };
}

/** The cost a provider reported for a call in US dollars: OpenRouter's `usage.cost`. Null when it reported none. */
export function reportedCost(provider: string, metadata: Record<string, unknown> | undefined): number | null {
  if (provider !== "openrouter") return null;
  const cost = (metadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * A call's cost at a per-million-token price, or null when it can't be worked out honestly: no price, an unknown
 * input or output count, or cached tokens with no cached rate listed (charging them at the full input rate would
 * overstate it). Reasoning tokens are already in the output count, so they're priced once, as output.
 */
export function estimateCost(tokens: CallTokens, price: ModelPrice | null): number | null {
  if (!price || tokens.input === null || tokens.output === null) return null;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  if (cacheRead > 0 && price.cacheRead === undefined) return null;
  if (cacheWrite > 0 && price.cacheWrite === undefined) return null;
  const fresh = Math.max(0, tokens.input - cacheRead - cacheWrite);
  const dollars = fresh * price.input + cacheRead * (price.cacheRead ?? 0) + cacheWrite * (price.cacheWrite ?? 0) + tokens.output * price.output;
  return dollars / 1e6;
}

/** The provider part of a model id: `openrouter`, `chatgpt`, or `custom:<provider id>` for a custom provider's model. */
export function providerOf(model: string): string {
  if (model.startsWith("custom:")) return `custom:${model.slice("custom:".length).split("/")[0]}`;
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(0, colon) : model;
}

export const billingOf = (model: string): Billing => (model.startsWith("chatgpt:") ? "subscription" : "api");

export const BUILT_IN_PROVIDERS: Record<string, string> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  chatgpt: "ChatGPT plan",
};

/** One stored call, as the summary reads it. */
export interface UsageRow {
  id: string;
  kind: UsageKind;
  status: UsageStatus;
  sessionId: string | null;
  runId: string | null;
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string | null;
  billing: Billing;
  inputTokens: number | null;
  inputCacheReadTokens: number | null;
  inputCacheWriteTokens: number | null;
  outputTokens: number | null;
  outputReasoningTokens: number | null;
  reportedCost: number | null;
  estimatedCost: number | null;
  startedAt: Date;
}

/**
 * Calls added up. Every token sum covers only the calls that reported it, and is null when none did; `unreported`
 * counts calls missing an input or output count, so a total is never mistaken for complete.
 *
 * Money is kept in separate buckets that are never added together: `reportedCost` and `estimatedCost` are API
 * spending (a call with a reported cost isn't estimated as well), and `apiEquivalent` is what subscription calls would
 * have cost at published API rates, which nobody was charged.
 */
export interface UsageTotals {
  calls: number;
  /** Calls that failed or were cancelled; whatever they reported is still counted. */
  incomplete: number;
  unreported: number;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  /** Input plus output, over calls that reported both. */
  total: number | null;
  reportedCost: number | null;
  estimatedCost: number | null;
  /** API calls whose cost is neither reported nor estimable. */
  unknownCost: number;
  apiEquivalent: number | null;
  /** Subscription calls with no defensible API price to compare with. */
  uncompared: number;
}

export function emptyTotals(): UsageTotals {
  return {
    calls: 0, incomplete: 0, unreported: 0, input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: null,
    reportedCost: null, estimatedCost: null, unknownCost: 0, apiEquivalent: null, uncompared: 0,
  };
}

const plus = (sum: number | null, value: number | null) => (value === null ? sum : (sum ?? 0) + value);

export function addRow(totals: UsageTotals, row: UsageRow): UsageTotals {
  totals.calls++;
  if (row.status !== "completed") totals.incomplete++;
  if (row.inputTokens === null || row.outputTokens === null) totals.unreported++;
  totals.input = plus(totals.input, row.inputTokens);
  totals.cacheRead = plus(totals.cacheRead, row.inputCacheReadTokens);
  totals.cacheWrite = plus(totals.cacheWrite, row.inputCacheWriteTokens);
  totals.output = plus(totals.output, row.outputTokens);
  totals.reasoning = plus(totals.reasoning, row.outputReasoningTokens);
  if (row.inputTokens !== null && row.outputTokens !== null) totals.total = plus(totals.total, row.inputTokens + row.outputTokens);
  if (row.billing === "subscription") {
    if (row.estimatedCost === null) totals.uncompared++;
    else totals.apiEquivalent = plus(totals.apiEquivalent, row.estimatedCost);
  } else if (row.reportedCost !== null) totals.reportedCost = plus(totals.reportedCost, row.reportedCost);
  else if (row.estimatedCost !== null) totals.estimatedCost = plus(totals.estimatedCost, row.estimatedCost);
  else totals.unknownCost++;
  return totals;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageRunGroup extends UsageGroup {
  kind: UsageKind;
  sessionId: string | null;
  model: string;
  billing: Billing;
  /** The worst outcome of its calls: one failed call marks the run failed. */
  status: UsageStatus;
  startedAt: Date;
}

export interface UsageDay {
  /** The learner's local date, YYYY-MM-DD. */
  day: string;
  api: number;
  subscription: number;
  calls: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  api: UsageTotals;
  subscription: UsageTotals;
  byProvider: (UsageGroup & { billing: Billing })[];
  byModel: (UsageGroup & { provider: string; providerLabel: string; billing: Billing })[];
  byKind: (UsageGroup & { kind: UsageKind })[];
  bySession: (UsageGroup & { lastAt: Date })[];
  runs: UsageRunGroup[];
  days: UsageDay[];
}

export const KIND_LABELS: Record<UsageKind, string> = {
  chat: "Chat replies",
  continuation: "Automatic continuations",
  lesson: "Lesson generation",
  distillation: "Reading imported notes",
  test: "Test model",
};

const STATUS_RANK: Record<UsageStatus, number> = { completed: 0, cancelled: 1, failed: 2 };

/** How many runs and sessions a summary lists; totals always cover every call in range. */
export const LISTED = 25;

function localDay(at: Date, offsetMinutes: number): string {
  return new Date(at.getTime() - offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Adds rows up by provider, model, kind, session, run and day. `offsetMinutes` is the learner's
 * `Date#getTimezoneOffset()`, so days are theirs. `labels` names providers by id at read time, so a renamed custom
 * provider shows its current name; a row's own snapshot is the fallback. Rows must be newest first.
 */
export function summarise(rows: UsageRow[], { offsetMinutes = 0, providerLabel = () => undefined }: { offsetMinutes?: number; providerLabel?: (provider: string) => string | undefined } = {}): UsageSummary {
  const totals = emptyTotals();
  const api = emptyTotals();
  const subscription = emptyTotals();
  const providers = new Map<string, UsageGroup & { billing: Billing }>();
  const models = new Map<string, UsageGroup & { provider: string; providerLabel: string; billing: Billing }>();
  const kinds = new Map<UsageKind, UsageGroup & { kind: UsageKind }>();
  const sessions = new Map<string, UsageGroup & { lastAt: Date }>();
  const runs = new Map<string, UsageRunGroup>();
  const days = new Map<string, UsageDay>();
  const nameOf = (row: UsageRow) => providerLabel(row.provider) ?? row.providerLabel;

  for (const row of rows) {
    addRow(totals, row);
    addRow(row.billing === "subscription" ? subscription : api, row);

    const provider = providers.get(row.provider) ?? { ...emptyTotals(), key: row.provider, label: nameOf(row), billing: row.billing };
    providers.set(row.provider, addRow(provider, row) as typeof provider);

    const model = models.get(row.model) ?? { ...emptyTotals(), key: row.model, label: row.modelLabel ?? row.model, provider: row.provider, providerLabel: nameOf(row), billing: row.billing };
    models.set(row.model, addRow(model, row) as typeof model);

    const kind = kinds.get(row.kind) ?? { ...emptyTotals(), key: row.kind, label: KIND_LABELS[row.kind], kind: row.kind };
    kinds.set(row.kind, addRow(kind, row) as typeof kind);

    if (row.sessionId) {
      const session = sessions.get(row.sessionId) ?? { ...emptyTotals(), key: row.sessionId, label: "", lastAt: row.startedAt };
      sessions.set(row.sessionId, addRow(session, row) as typeof session);
    }

    const runKey = row.runId ?? row.id;
    const run = runs.get(runKey) ?? {
      ...emptyTotals(), key: runKey, label: row.modelLabel ?? row.model, kind: row.kind, sessionId: row.sessionId, model: row.model, billing: row.billing,
      status: row.status, startedAt: row.startedAt,
    };
    if (STATUS_RANK[row.status] > STATUS_RANK[run.status]) run.status = row.status;
    if (row.startedAt < run.startedAt) run.startedAt = row.startedAt;
    runs.set(runKey, addRow(run, row) as UsageRunGroup);

    const key = localDay(row.startedAt, offsetMinutes);
    const day = days.get(key) ?? { day: key, api: 0, subscription: 0, calls: 0 };
    day.calls++;
    if (row.inputTokens !== null && row.outputTokens !== null) day[row.billing] += row.inputTokens + row.outputTokens;
    days.set(key, day);
  }

  const byTokens = <T extends UsageTotals>(a: T, b: T) => (b.total ?? 0) - (a.total ?? 0) || b.calls - a.calls;
  return {
    totals,
    api,
    subscription,
    byProvider: [...providers.values()].sort(byTokens),
    byModel: [...models.values()].sort(byTokens),
    byKind: [...kinds.values()].sort(byTokens),
    // Rows come newest first, so insertion order is most recently used first.
    bySession: [...sessions.values()].slice(0, LISTED),
    runs: [...runs.values()].slice(0, LISTED),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
