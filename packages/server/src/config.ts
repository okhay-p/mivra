import { homedir } from "node:os";
import { join } from "node:path";
import { reasoningEfforts, type ReasoningEffort } from "./model.js";

export interface Config {
  port: number;
  dataDir: string;
  /** The first-run default model (MIVRA_MODEL); the learner changes it in the UI (ADR-012). */
  model: string;
  /** How hard OpenRouter models think (MIVRA_REASONING_EFFORT). With `model`, only the first-run default (ADR-012). */
  reasoningEffort?: ReasoningEffort;
  /** Extra Host names the server accepts besides loopback (comma-separated MIVRA_ALLOWED_HOSTS). */
  allowedHosts: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const effort = env.MIVRA_REASONING_EFFORT || undefined;
  if (effort && !reasoningEfforts.includes(effort as ReasoningEffort)) {
    throw new Error(`MIVRA_REASONING_EFFORT must be one of ${reasoningEfforts.join(", ")}; got "${effort}".`);
  }
  return {
    port: Number(env.MIVRA_PORT ?? 4096),
    dataDir: env.MIVRA_DATA_DIR ?? join(homedir(), ".mivra"),
    model: env.MIVRA_MODEL ?? "anthropic:claude-sonnet-5-5",
    reasoningEffort: effort as ReasoningEffort | undefined,
    allowedHosts: (env.MIVRA_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}
