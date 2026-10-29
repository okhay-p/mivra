import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMiddleware } from "hono/factory";

export interface SecurityConfig {
  /** Bearer token every /api request must carry (except PUBLIC_API_PATHS). */
  token: string;
  /** Extra Host names accepted besides loopback, e.g. a tailnet name. */
  allowedHosts: string[];
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const PUBLIC_API_PATHS = new Set(["/api/health", "/api/doc"]);

export const TOKEN_FILE = "auth-token";

/** Reads the local API token from the data dir, creating it (mode 0600) on first run. */
export function loadOrCreateToken(dataDir: string): string {
  const path = join(dataDir, TOKEN_FILE);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Not created yet.
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * Rejects requests whose Host is not loopback or explicitly allowed. This blocks DNS rebinding,
 * where a hostile page points its own domain at 127.0.0.1 to read responses (including the token
 * embedded in index.html).
 */
export function hostGuard(allowedHosts: string[]) {
  const allowed = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map((h) => h.toLowerCase())]);
  return createMiddleware(async (c, next) => {
    const hostname = new URL(c.req.url).hostname.toLowerCase();
    if (!allowed.has(hostname)) return c.json({ error: "Host not allowed" }, 403);
    await next();
  });
}

/** Requires `Authorization: Bearer <token>`. Blocks cross-site requests and other local users. */
export function tokenGuard(token: string) {
  const expected = Buffer.from(token);
  return createMiddleware(async (c, next) => {
    if (PUBLIC_API_PATHS.has(c.req.path)) return next();
    const header = c.req.header("authorization") ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: "Missing or invalid API token" }, 401);
    }
    await next();
  });
}
