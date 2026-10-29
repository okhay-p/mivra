import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry, type LanguageModel } from "ai";

export interface RegistryOptions {
  /** Defaults to the OPENROUTER_API_KEY environment variable. */
  openrouterApiKey?: string;
  /** Override fetch, for tests. */
  fetch?: typeof fetch;
}

export function createRegistry(options: RegistryOptions = {}) {
  return createProviderRegistry({
    anthropic,
    openai,
    openrouter: createOpenRouter({
      apiKey: options.openrouterApiKey,
      fetch: options.fetch,
      // "strict" is the setting OpenRouter recommends when talking to its own API.
      compatibility: "strict",
      // Shown in the OpenRouter dashboard's app attribution.
      appName: "Mivra",
      appUrl: "https://github.com/okhay-p/mivra",
    }),
  });
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
