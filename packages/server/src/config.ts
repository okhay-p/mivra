import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  model: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.MIVRA_PORT ?? 4096),
    dataDir: env.MIVRA_DATA_DIR ?? join(homedir(), ".mivra"),
    model: env.MIVRA_MODEL ?? "anthropic:claude-sonnet-5-5",
  };
}
