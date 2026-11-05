import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  /**
   * The address to listen on: loopback unless MIVRA_HOST says otherwise (ADR-001). The Docker image sets 0.0.0.0,
   * since a container's loopback can't be reached through a published port; `docker run` then publishes on the
   * host's 127.0.0.1 (ADR-013).
   */
  host: string;
  /** Whether MIVRA_PORT chose the port. Then a taken port is an error, never a different port (ADR-013). */
  portExplicit: boolean;
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
    host: env.MIVRA_HOST?.trim() || "127.0.0.1",
    portExplicit: env.MIVRA_PORT !== undefined && env.MIVRA_PORT !== "",
    dataDir: env.MIVRA_DATA_DIR ?? join(homedir(), ".mivra"),
    allowedHosts: (env.MIVRA_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    ignored: RETIRED.filter((name) => env[name]),
  };
}
