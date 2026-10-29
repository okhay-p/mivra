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
