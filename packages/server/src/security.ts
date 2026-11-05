import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
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

/**
 * Whether a request comes from this machine (ADR-013). The peer address must be loopback, which a client can't
 * fake. That alone isn't enough: a proxy on this machine, such as `tailscale serve`, connects from loopback on
 * behalf of other devices. Those requests carry the proxy's Host (an allowed name, not a loopback one) or a
 * forwarding header, so either makes a request remote. Requests that didn't arrive over a socket (such as
 * `app.request` in tests) don't count as local.
 */
export function isLoopbackPeer(c: Context): boolean {
  let address: string | undefined;
  try {
    address = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (address !== "::1" && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return false;
  if (!LOOPBACK_HOSTS.includes(new URL(c.req.url).hostname.toLowerCase())) return false;
  return !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"].some((name) => c.req.header(name) !== undefined);
}
