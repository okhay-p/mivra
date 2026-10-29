import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createProviderRegistry, type LanguageModel } from "ai";

const registry = createProviderRegistry({ anthropic, openai });

/** Resolves a "<provider>:<model-id>" string, e.g. "anthropic:claude-sonnet-5-5". */
export function resolveModel(id: string): LanguageModel {
  return registry.languageModel(id as `anthropic:${string}` | `openai:${string}`);
}
