import { randomUUID } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import { z } from "zod";
import type { ModelSelection } from "../model.js";
import type { ModelPrice } from "../models/catalog.js";
import type { SettingsStore } from "../store/settings-store.js";
import type { UsageStore } from "../store/usage-store.js";
import {
  BUILT_IN_PROVIDERS,
  billingOf,
  callTokens,
  estimateCost,
  NO_TOKENS,
  providerOf,
  reportedCost,
  type PriceSnapshot,
  type ProviderUsage,
  type UsageKind,
  type UsageStatus,
} from "./accounting.js";

/** Who a model call was for. Each tracked call records this, never what was said. */
export interface UsageContext {
  kind: UsageKind;
  /** The selection the call runs with; its model decides the provider, billing and price. */
  selection: ModelSelection;
  sessionId?: string | null;
  /** Groups a run's calls (its tool-call steps); a model test passes its own id. */
  runId?: string | null;
}

/** What's known about a model when one of its calls ends: its current price and display names. */
export interface ModelFacts {
  price: PriceSnapshot | null;
  modelLabel: string | null;
  providerLabel: string;
}

export interface UsageTrackerOptions {
  store: UsageStore;
  describe: (model: string) => Promise<ModelFacts>;
  clock?: () => Date;
}

type FinishPart = { type: "finish"; usage?: ProviderUsage; providerMetadata?: Record<string, unknown> };

/**
 * Records each model call's usage (issue #70) from inside the AI SDK, as language-model middleware, so every call
 * Mivra makes is counted the same way: each step of a chat reply or continuation, lesson generation and model tests,
 * including failed and cancelled calls and retries. A call is recorded exactly once, when its stream finishes, fails
 * or is cancelled. Tokens come from the provider's finish part; a call that never got one is recorded with unknown
 * usage, never zero. Recording never affects the reply: its price lookup runs alongside and errors are dropped.
 */
export function createUsageTracker({ store, describe, clock = () => new Date() }: UsageTrackerOptions) {
  const pending = new Set<Promise<void>>();
  // Bumped when the history is cleared: a call that ended before that is part of the cleared history, even if its
  // price lookup finishes afterwards.
  let generation = 0;

  function middleware(context: UsageContext): LanguageModelMiddleware {
    let seq = 0;
    const model = context.selection.model;
    const provider = providerOf(model);
    return {
      wrapStream: async ({ doStream, params }) => {
        const id = randomUUID();
        const callSeq = seq++;
        const startedAt = clock();
        // Looked up as the call starts, so a slow model list never holds up the end of a reply.
        const facts = describe(model).catch((): ModelFacts => ({ price: null, modelLabel: null, providerLabel: BUILT_IN_PROVIDERS[provider] ?? provider }));
        let finish: FinishPart | undefined;
        let recorded = false;
        const onAbort = () => record("cancelled");
        function record(status: UsageStatus) {
          if (recorded) return;
          recorded = true;
          params.abortSignal?.removeEventListener("abort", onAbort);
          const endedAt = clock();
          const tokens = finish ? callTokens(finish.usage) : NO_TOKENS;
          const reported = finish ? reportedCost(provider, finish.providerMetadata) : null;
          const ended = generation;
          const task = facts
            .then(({ price, modelLabel, providerLabel }) => {
              if (ended !== generation) return;
              store.insert({
                id,
                kind: context.kind,
                status,
                sessionId: context.sessionId ?? null,
                runId: context.runId ?? null,
                seq: callSeq,
                provider,
                providerLabel,
                model,
                modelLabel,
                effort: context.selection.effort,
                billing: billingOf(model),
                inputTokens: tokens.input,
                inputNoCacheTokens: tokens.noCache,
                inputCacheReadTokens: tokens.cacheRead,
                inputCacheWriteTokens: tokens.cacheWrite,
                outputTokens: tokens.output,
                outputReasoningTokens: tokens.reasoning,
                reportedCost: reported,
                price,
                estimatedCost: estimateCost(tokens, price),
                startedAt,
                endedAt,
              });
            })
            .catch(() => {
              // Accounting must never break or delay a reply.
            })
            .finally(() => pending.delete(task));
          pending.add(task);
        }

        if (params.abortSignal?.aborted) {
          record("cancelled");
          return doStream();
        }
        params.abortSignal?.addEventListener("abort", onAbort, { once: true });
        let result: Awaited<ReturnType<typeof doStream>>;
        try {
          result = await doStream();
        } catch (error) {
          record(params.abortSignal?.aborted ? "cancelled" : "failed");
          throw error;
        }
        const reader = result.stream.getReader();
        let errored = false;
        return {
          ...result,
          stream: new ReadableStream({
            async pull(controller) {
              let next: Awaited<ReturnType<typeof reader.read>>;
              try {
                next = await reader.read();
              } catch (error) {
                record(params.abortSignal?.aborted ? "cancelled" : "failed");
                controller.error(error);
                return;
              }
              if (next.done) {
                // A stream that ends without a finish part was cut short: whatever it cost wasn't reported.
                record(finish && !errored ? "completed" : params.abortSignal?.aborted ? "cancelled" : "failed");
                controller.close();
                return;
              }
              const part = next.value as { type: string };
              if (part.type === "finish") finish = part as FinishPart;
              else if (part.type === "error") errored = true;
              controller.enqueue(next.value);
            },
            async cancel(reason) {
              record(finish && !errored ? "completed" : "cancelled");
              await reader.cancel(reason);
            },
          }),
        };
      },
    };
  }

  return {
    /** Middleware that records every call of one run, lesson job or model test. */
    middleware,
    /** Clears the history, including calls that have ended but are still being written. Returns how many rows went. */
    clear(clearStore: () => number): number {
      generation++;
      return clearStore();
    },
    /** Resolves once every call that has ended is written; for tests. */
    async settled() {
      while (pending.size > 0) await Promise.all(pending);
    },
  };
}

export type UsageTracker = ReturnType<typeof createUsageTracker>;

const PRICES_KEY = "usage.prices";
const Rate = z.number().finite().min(0).max(100_000);
/** A learner's own price for a model, in US dollars per million tokens (issue #70, under Advanced). */
export const CustomPrice = z.object({ input: Rate, output: Rate, cacheRead: Rate.optional(), cacheWrite: Rate.optional() }).strict();
const StoredPrices = z.record(z.string().max(1000), CustomPrice);
/** Enough for every model a learner could reasonably price by hand. */
export const MAX_CUSTOM_PRICES = 200;

/** The learner's own model prices, kept in settings. They apply to calls that end after they're saved. */
export function createCustomPrices(settings: SettingsStore) {
  const load = (): Record<string, ModelPrice> => {
    const parsed = StoredPrices.safeParse(settings.get(PRICES_KEY) ?? {});
    return parsed.success ? parsed.data : {};
  };
  return {
    all: load,
    get: (model: string): ModelPrice | undefined => load()[model],
    /** Sets a model's price, or with null removes it. Returns false when there are already too many. */
    set(model: string, price: ModelPrice | null): boolean {
      const prices = load();
      if (price === null) delete prices[model];
      else {
        if (!(model in prices) && Object.keys(prices).length >= MAX_CUSTOM_PRICES) return false;
        prices[model] = price;
      }
      settings.set(PRICES_KEY, prices);
      return true;
    },
  };
}

export type CustomPrices = ReturnType<typeof createCustomPrices>;
