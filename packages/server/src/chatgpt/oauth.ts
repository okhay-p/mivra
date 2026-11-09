import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { z } from "zod";

/**
 * Sign in with ChatGPT, open-source route (ADR-015): OAuth 2.0 with PKCE against auth.openai.com, written from
 * OpenAI's protocol documentation. Everything the route requires lives here, so a change on OpenAI's side is a
 * change to this file.
 */
export const ISSUER = "https://auth.openai.com";
/** The API ChatGPT tokens are issued for, and the only place they are sent. */
export const CHATGPT_API = "https://api.openai.com/v1";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/** Without this scope the tokens identify the learner but can't use their plan. */
export const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
/** The first-time registration entry point. Never saved, and never used to exchange a code. */
export const REGISTRATION_CLIENT = "dynamic_agent_client";
export const CALLBACK_PATH = "/auth/callback";
export const APP_NAME = "Mivra";
const TIMEOUT_MS = 15_000;
/** Seconds of clock skew allowed when checking an ID token's expiry. */
const CLOCK_TOLERANCE_S = 30;

/** A failure with a message that is safe to show the learner. `code` is OpenAI's error code or one of Mivra's. */
export class ChatGptError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "ChatGptError";
  }
}

/** Refresh errors after which the session can't be renewed and the learner must sign in again. */
export const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const MESSAGES: Record<string, string> = {
  access_denied: "Sign-in wasn't completed. You can try again when you're ready.",
  invalid_client: "ChatGPT didn't accept Mivra's registration. Sign in again with a different account to register afresh.",
  subscription_sharing_user_not_eligible: "This ChatGPT account or workspace can't share its plan with apps. Sign-in with ChatGPT needs an eligible Plus or Pro plan.",
};
const SIGN_IN_AGAIN = "Your ChatGPT sign-in has expired. Sign in again under Model providers.";

/** Turns an OAuth error body into a ChatGptError with a server-owned message (provider text is never shown). */
export function oauthError(body: unknown, status?: number): ChatGptError {
  const code = errorCode(body) ?? (status ? `http_${status}` : "unknown_error");
  if (TERMINAL_REFRESH_ERRORS.has(code)) return new ChatGptError(code, SIGN_IN_AGAIN);
  const message = MESSAGES[code];
  if (message) return new ChatGptError(code, message);
  const retryable = status === undefined || status >= 500 || status === 429;
  return new ChatGptError(code, retryable ? "ChatGPT's sign-in service is unavailable. Try again shortly." : "ChatGPT sign-in failed. Try again.", retryable);
}

/** OpenAI's error code from an OAuth (`{ error: "code" }`) or API (`{ error: { code } }`, `{ detail }`) body. */
export function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  const code = typeof error === "string" ? error : error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z0-9_.-]{1,100}$/i.test(code) ? code : undefined;
}

const randomValue = () => randomBytes(32).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** Constant-time comparison for state values. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const Discovery = z.object({
  issuer: z.literal(ISSUER),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  revocation_endpoint: z.string().url().optional(),
});
type Discovery = z.infer<typeof Discovery>;

const TokenResponse = z.object({
  access_token: z.string().min(1).max(20_000),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  expires_in: z.number().positive().max(366 * 24 * 3600),
  refresh_token: z.string().min(1).max(20_000).optional(),
  id_token: z.string().min(1).max(20_000).optional(),
  scope: z.string().max(2000).optional(),
});

/** Tokens for one ChatGPT session. `expiresAt` is in milliseconds since the epoch. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  idToken: string;
}

/** The verified account behind an ID token. `subject` is stable; email and name are for display. */
export interface Identity {
  subject: string;
  email: string | null;
  name: string | null;
}

/** A sign-in waiting for the browser to come back to `redirectUri`. */
export interface Authorization {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The saved client id this sign-in reuses, if any. */
  clientId: string | null;
}

export interface AuthorizeOptions {
  redirectUri: string;
  hostId: string;
  /** Reuse a registration; omitted, the sign-in registers Mivra afresh. */
  clientId?: string | null;
  loginHint?: string | null;
}

export interface OAuthClientOptions {
  fetch?: typeof fetch;
  clock?: () => number;
}

type Jwks = { keys: (JsonWebKey & { kid?: string })[] };

/** The protocol: discovery, the authorize URL, code exchange, refresh, revocation and ID-token checks. */
export function createOAuthClient({ fetch: fetchImpl = fetch, clock = Date.now }: OAuthClientOptions = {}) {
  let discovery: Promise<Discovery> | undefined;
  let jwks: { uri: string; keys: Jwks["keys"]; loadedAt: number } | undefined;

  async function request(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      // A redirect could carry a code or refresh token to another origin.
      response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ChatGptError("network_error", "Couldn't reach ChatGPT. Check your connection and try again.", true);
    }
    const text = await response.text().catch(() => "");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  function config(): Promise<Discovery> {
    discovery ??= (async () => {
      const { status, body } = await request(`${ISSUER}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
      const parsed = Discovery.safeParse(body);
      // Every endpoint must stay on the issuer's origin, or a tampered document could collect codes and tokens.
      const sameOrigin = parsed.success && [parsed.data.authorization_endpoint, parsed.data.token_endpoint, parsed.data.jwks_uri, parsed.data.revocation_endpoint]
        .every((url) => url === undefined || new URL(url).origin === ISSUER);
      if (status !== 200 || !parsed.success || !sameOrigin) {
        throw new ChatGptError("discovery_failed", "ChatGPT's sign-in configuration couldn't be verified. Try again shortly.", true);
      }
      return parsed.data;
    })().catch((error: unknown) => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  }

  async function tokenRequest(params: Record<string, string>): Promise<z.infer<typeof TokenResponse>> {
    const { token_endpoint } = await config();
    const { status, body } = await request(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params),
    });
    if (status !== 200) throw oauthError(body, status);
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw new ChatGptError("invalid_token_response", "ChatGPT returned incomplete credentials. Sign in again.");
    return parsed.data;
  }

  async function signingKey(kid: string | undefined): Promise<JsonWebKey> {
    const { jwks_uri } = await config();
    const find = () => jwks?.keys.find((k) => k.kty === "RSA" && (kid === undefined || k.kid === kid));
    // Reload on an unknown key id (keys rotate), but not more than once a minute.
    if (!jwks || jwks.uri !== jwks_uri || (!find() && clock() - jwks.loadedAt > 60_000)) {
      const { status, body } = await request(jwks_uri, { headers: { accept: "application/json" } });
      const keys = (body as Jwks | undefined)?.keys;
      if (status !== 200 || !Array.isArray(keys)) {
        throw new ChatGptError("identity_unavailable", "ChatGPT's identity check is unavailable. Try again shortly.", true);
      }
      jwks = { uri: jwks_uri, keys, loadedAt: clock() };
    }
    const key = find();
    if (!key) throw invalidIdentity();
    return key;
  }

  /** Checks an ID token's signature and claims, and returns the account it names. */
  async function verifyIdToken(idToken: string, clientId: string, nonce?: string): Promise<Identity> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw invalidIdentity();
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    } catch {
      throw invalidIdentity();
    }
    if (header.alg !== "RS256" || !claims || typeof claims !== "object") throw invalidIdentity();
    const jwk = await signingKey(typeof header.kid === "string" ? header.kid : undefined);
    let valid: boolean;
    try {
      valid = verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signaturePart, "base64url"));
    } catch {
      valid = false;
    }
    const now = clock() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      !valid ||
      claims.iss !== ISSUER ||
      !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      typeof claims.exp !== "number" ||
      claims.exp + CLOCK_TOLERANCE_S < now ||
      typeof claims.iat !== "number" ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      (nonce !== undefined && (typeof claims.nonce !== "string" || !sameSecret(claims.nonce, nonce)))
    ) {
      throw invalidIdentity();
    }
    const text = (value: unknown) => (typeof value === "string" && value.length <= 320 ? value : null);
    return { subject: claims.sub, email: text(claims.email), name: text(claims.name) };
  }

  const tokensFrom = (data: z.infer<typeof TokenResponse>, fallback: { refreshToken?: string; scopes?: string[]; idToken?: string } = {}) => {
    const refreshToken = data.refresh_token ?? fallback.refreshToken;
    const idToken = data.id_token ?? fallback.idToken;
    // OAuth may leave out scope on a refresh when it hasn't changed.
    const scopes = data.scope !== undefined ? data.scope.split(/\s+/).filter(Boolean) : fallback.scopes ?? [];
    if (!refreshToken || !idToken) throw new ChatGptError("invalid_token_response", "ChatGPT returned incomplete credentials. Sign in again.");
    if (!scopes.includes(DIRECT_SCOPE)) {
      throw new ChatGptError("scope_not_granted", "ChatGPT didn't grant Mivra use of your plan. Sign in again and allow it.");
    }
    return { accessToken: data.access_token, refreshToken, expiresAt: clock() + data.expires_in * 1000, scopes, idToken } satisfies Tokens;
  };

  return {
    /** The authorize URL for a new sign-in, with fresh state, nonce and PKCE verifier. */
    async authorize({ redirectUri, hostId, clientId, loginHint }: AuthorizeOptions): Promise<Authorization> {
      const { authorization_endpoint } = await config();
      const state = randomValue();
      const nonce = randomValue();
      const verifier = randomValue();
      const url = new URL(authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: clientId ?? REGISTRATION_CLIENT,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: CHATGPT_API,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: sha256(verifier),
        ext_agent_host_id: hostId,
      }).toString();
      if (!clientId) url.searchParams.set("agent_name_hint", APP_NAME);
      // Only the email: tokens in a URL end up in browser history and process arguments.
      if (clientId && loginHint) url.searchParams.set("login_hint", loginHint);
      return { url: url.toString(), state, nonce, verifier, redirectUri, clientId: clientId ?? null };
    },

    /** Exchanges the code from a validated callback, and verifies who signed in. */
    async exchange(pending: Authorization, callback: { code: string; clientId: string }): Promise<{ tokens: Tokens; identity: Identity }> {
      const data = await tokenRequest({
        grant_type: "authorization_code",
        client_id: callback.clientId,
        code: callback.code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        resource: CHATGPT_API,
      });
      if (!data.id_token) throw new ChatGptError("invalid_token_response", "ChatGPT didn't say which account signed in. Try again.");
      const identity = await verifyIdToken(data.id_token, callback.clientId, pending.nonce);
      return { tokens: tokensFrom(data), identity };
    },

    /** Renews a session. The refresh token rotates: the old one stops working once this succeeds. */
    async refresh(clientId: string, tokens: Tokens): Promise<Tokens> {
      const data = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refreshToken, resource: CHATGPT_API });
      return tokensFrom(data, tokens);
    },

    verifyIdToken,

    /** Ends a session at OpenAI. Resolves false when that couldn't be confirmed. */
    async revoke(clientId: string, refreshToken: string): Promise<boolean> {
      try {
        const { revocation_endpoint } = await config();
        if (!revocation_endpoint) return false;
        const { status } = await request(revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }),
        });
        return status === 200;
      } catch {
        return false;
      }
    },
  };
}

export type OAuthClient = ReturnType<typeof createOAuthClient>;

const invalidIdentity = () => new ChatGptError("invalid_id_token", "ChatGPT's answer about who signed in couldn't be verified. Sign in again.");

/** Issued client ids look like `oaiapp_…`. Anything else in a callback is refused. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,200}$/;

export type CallbackResult = { ok: true; code: string; clientId: string } | { ok: false; error: ChatGptError };

/**
 * Reads the browser's return to the callback. The state must match the pending sign-in; a reauthorization may
 * leave out the client id, and must not change it.
 */
export function readCallback(params: URLSearchParams, pending: Authorization): CallbackResult | "wrong-state" {
  const state = params.getAll("state");
  if (state.length !== 1 || !sameSecret(state[0]!, pending.state)) return "wrong-state";
  if (params.has("error")) return { ok: false, error: oauthError({ error: params.get("error") }) };
  const codes = params.getAll("code");
  const clientIds = params.getAll("client_id");
  const clientId = clientIds[0] ?? pending.clientId;
  if (
    codes.length !== 1 ||
    !codes[0] ||
    clientIds.length > 1 ||
    !clientId ||
    !CLIENT_ID.test(clientId) ||
    clientId === REGISTRATION_CLIENT ||
    (pending.clientId !== null && clientIds.length === 1 && clientIds[0] !== pending.clientId)
  ) {
    return { ok: false, error: new ChatGptError("registration_incomplete", "ChatGPT didn't finish registering Mivra. Try signing in again.") };
  }
  return { ok: true, code: codes[0], clientId };
}
