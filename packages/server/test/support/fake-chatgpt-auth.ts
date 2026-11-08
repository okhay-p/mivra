import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { CHATGPT_API, ISSUER } from "../../src/chatgpt/oauth.js";

export const DIRECT = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// RSA key generation is slow; one pair signs every test's ID tokens, another forges them.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const forgingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

/** A stand-in for auth.openai.com: discovery, JWKS, the token endpoint and revocation. */
export function fakeAuth({ subject = "user-1", email = "learner@example.com", scope = DIRECT, discovery = {} as Record<string, string> } = {}) {
  const state = {
    subject,
    email,
    scope,
    clientId: "oaiapp_first",
    issuedCodes: new Map<string, { challenge: string; nonce: string; clientId: string }>(),
    refreshToken: "refresh-1",
    refreshes: 0,
    revoked: [] as string[],
    tokenCalls: [] as URLSearchParams[],
    refreshError: undefined as string | undefined,
    idTokenKey: privateKey as KeyObject,
    nonceOverride: undefined as string | undefined,
  };
  const idToken = (clientId: string, nonce?: string) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: clientId, sub: state.subject, email: state.email, iat: now, exp: now + 3600, ...(nonce ? { nonce: state.nonceOverride ?? nonce } : {}) }),
    ).toString("base64url");
    return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), state.idTokenKey).toString("base64url")}`;
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
        token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
        ...discovery,
      });
    }
    if (url.href === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    const body = new URLSearchParams(String(init?.body));
    if (url.href === `${ISSUER}/api/accounts/oauth/revoke`) {
      state.revoked.push(body.get("token")!);
      return new Response(null, { status: 200 });
    }
    if (url.href === `${ISSUER}/api/accounts/oauth/token`) {
      state.tokenCalls.push(body);
      if (body.get("resource") !== CHATGPT_API) return json({ error: "invalid_target" }, 400);
      if (body.get("grant_type") === "authorization_code") {
        const issued = state.issuedCodes.get(body.get("code")!);
        if (!issued || issued.clientId !== body.get("client_id")) return json({ error: "invalid_grant" }, 400);
        if (createHash("sha256").update(body.get("code_verifier")!).digest("base64url") !== issued.challenge) return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "access-1", token_type: "Bearer", expires_in: 3600, refresh_token: state.refreshToken, id_token: idToken(issued.clientId, issued.nonce), scope: state.scope });
      }
      if (body.get("grant_type") === "refresh_token") {
        if (state.refreshError) return json({ error: state.refreshError }, 400);
        if (body.get("refresh_token") !== state.refreshToken) return json({ error: "refresh_token_reused" }, 400);
        state.refreshes++;
        state.refreshToken = `refresh-${state.refreshes + 1}`;
        return json({ access_token: `access-${state.refreshes + 1}`, token_type: "Bearer", expires_in: 3600, refresh_token: state.refreshToken, id_token: idToken(body.get("client_id")!) });
      }
    }
    return json({ error: "not_found" }, 404);
  };
  /** What the browser does: approve the authorize URL and get the callback address back. */
  const approve = (authorizeUrl: string, { clientId = state.clientId, includeClientId = true } = {}) => {
    const url = new URL(authorizeUrl);
    const code = `code-${state.issuedCodes.size + 1}`;
    state.issuedCodes.set(code, { challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce")!, clientId });
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("scope", state.scope);
    back.searchParams.set("state", url.searchParams.get("state")!);
    if (includeClientId) back.searchParams.set("client_id", clientId);
    return back.toString();
  };
  return { state, fetch: fetchImpl, approve, idToken };
}
