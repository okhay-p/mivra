import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry, type LanguageModel, type streamText } from "ai";

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

/** Every effort level OpenRouter accepts. Each model supports a subset, listed in the catalog. */
export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

/** The model a run uses (ADR-012). A null effort leaves it to the model's default. */
export interface ModelSelection {
  model: string;
  effort: ReasoningEffort | null;
}

export interface RegistryOptions {
  /** Each defaults to its environment variable: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY. */
  openrouterApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Override fetch, for tests. */
  fetch?: typeof fetch;
}

export function createRegistry(options: RegistryOptions = {}) {
  const openrouter = createOpenRouter({
    apiKey: options.openrouterApiKey,
    fetch: options.fetch,
    // "strict" is the setting OpenRouter recommends when talking to its own API.
    compatibility: "strict",
    // Shown in the OpenRouter dashboard's app attribution.
    appName: "Mivra",
    appUrl: "https://github.com/okhay-p/mivra",
  });
  // @openrouter/ai-sdk-provider 3.1.0 returns v4 models but its provider object doesn't declare
  // specificationVersion. The registry then treats it as a v2 provider and runs its models through a
  // v2→v4 adapter, which wraps finishReason twice. The SDK no longer sees "tool-calls", so tools never
  // execute. Declaring v4 makes the registry pass the provider through unchanged.
  Object.assign(openrouter, { specificationVersion: "v4" as const });

  const anthropic = createAnthropic({ apiKey: options.anthropicApiKey, fetch: options.fetch });
  const openai = createOpenAI({ apiKey: options.openaiApiKey, fetch: options.fetch });
  return createProviderRegistry({ anthropic, openai, openrouter });
}

const defaultRegistry = createRegistry();

type ModelId = `anthropic:${string}` | `openai:${string}` | `openrouter:${string}`;

/**
 * Resolves a "<provider>:<model-id>" string, e.g. "anthropic:claude-sonnet-5-5" or
 * "openrouter:anthropic/claude-sonnet-5.5". Only the first ":" separates the provider, so
 * OpenRouter ids such as "openrouter:meta-llama/llama-3.3-70b-instruct:free" work.
 */
export function resolveModel(id: string, registry = defaultRegistry): LanguageModel {
  return registry.languageModel(id as ModelId);
}

/** Per-call options for a selection: its effort, in the form each provider takes (ADR-012). */
export function callOptionsFor(selection: ModelSelection): { reasoning?: ReasoningEffort; providerOptions?: ProviderOptions } {
  if (!selection.effort) return {};
  // OpenRouter takes effort in its own request field; the AI SDK's `reasoning` option doesn't reach it.
  if (selection.model.startsWith("openrouter:")) return { providerOptions: { openrouter: { reasoning: { effort: selection.effort } } } };
  // Anthropic and OpenAI map the AI SDK's level onto their own settings (Anthropic's effort and adaptive thinking,
  // OpenAI's reasoningEffort).
  return { reasoning: selection.effort };
}
