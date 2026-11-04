import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  /** Extra Host names the server accepts besides loopback (comma-separated MIVRA_ALLOWED_HOSTS). */
  allowedHosts: string[];
  /** Variables still set that Mivra no longer reads; the model is chosen in the UI now (ADR-012). */
  ignored: string[];
}

const RETIRED = ["MIVRA_MODEL", "MIVRA_REASONING_EFFORT"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.MIVRA_PORT ?? 4096),
    dataDir: env.MIVRA_DATA_DIR ?? join(homedir(), ".mivra"),
    allowedHosts: (env.MIVRA_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    ignored: RETIRED.filter((name) => env[name]),
  };
}
