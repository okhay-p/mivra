import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { CHATGPT_USAGE_LIMIT_ERROR } from "@mivra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CHATGPT_API, ISSUER, createOAuthClient } from "../src/chatgpt/oauth.js";
import { CHATGPT_FILE, chatGptFileStore, createChatGptSession, memoryChatGptStore, type ChatGptFile, type ChatGptSession } from "../src/chatgpt/session.js";
import { memoryCredentials } from "../src/credentials.js";
import { openDb } from "../src/db/client.js";
import { callOptionsFor, createRegistry, resolveModel } from "../src/model.js";
import { describeChatGptModels, parseChatGptModels, type CatalogModel } from "../src/models/catalog.js";
import { CHATGPT_DEFAULT, defaultSelectionFor } from "../src/models/selection.js";
import { publicErrorText } from "../src/runtime/errors.js";
import { DIRECT, fakeAuth, forgingKey } from "./support/fake-chatgpt-auth.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sessions: ChatGptSession[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Parameters<typeof fakeAuth>[0] = {}, { initial, clock }: { initial?: ChatGptFile; clock?: () => number } = {}) {
  const auth = fakeAuth(options);
  const store = memoryChatGptStore(initial);
  const session = createChatGptSession({ store, oauth: createOAuthClient({ fetch: auth.fetch, clock }), clock, callbackPort: 0 });
  sessions.push(session);
  return { auth, store, session };
}

/** A browser request to the callback listener, with the Host header it would send (or another). */
function visit(address: string, host?: string): Promise<{ status: number; body: string }> {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { host: host ?? url.host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function signIn(ctx: ReturnType<typeof setup>, approveOptions?: Parameters<ReturnType<typeof fakeAuth>["approve"]>[1]) {
  const started = await ctx.session.startSignIn();
  const page = await visit(ctx.auth.approve(started.url, approveOptions));
  return { started, page, view: await started.done };
}

describe("signing in with ChatGPT", () => {
  it("registers Mivra, listens on 127.0.0.1 for the callback, and saves the verified account", async () => {
    const ctx = setup();
    const started = await ctx.session.startSignIn();
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Mivra",
      response_type: "code",
      scope: DIRECT,
      resource: CHATGPT_API,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(ctx.session.view().pending).toBe(true);

    const page = await visit(ctx.auth.approve(started.url));
    expect(page.status).toBe(200);
    expect(page.body).toContain("Signed in to ChatGPT");
    expect(await started.done).toMatchObject({ signedIn: true, email: "learner@example.com", pending: false, notice: null });
    const file = ctx.store.current()!;
    expect(file.registration).toMatchObject({ clientId: "oaiapp_first", subject: "user-1" });
    expect(file.tokens).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
    // The exchange used the issued client id, never the registration entry point.
    expect(ctx.auth.state.tokenCalls[0]!.get("client_id")).toBe("oaiapp_first");
    expect(await ctx.session.accessToken()).toBe("access-1");
    expect(ctx.session.signature()).toBe("user-1");
  });

  it("ignores requests that aren't the browser coming back to this sign-in", async () => {
    const ctx = setup();
    const started = await ctx.session.startSignIn();
    const back = ctx.auth.approve(started.url);
    const wrongState = new URL(back);
    wrongState.searchParams.set("state", "forged");
    expect((await visit(wrongState.toString())).status).toBe(400);
    // A page on another origin can't use DNS rebinding to reach the listener.
    expect((await visit(back, "evil.example:80")).status).toBe(404);
    expect(ctx.session.view().pending).toBe(true);
    expect((await visit(back)).status).toBe(200);
    expect((await started.done).signedIn).toBe(true);
    // The code is spent: a replay finds no sign-in waiting.
    await expect(visit(back)).rejects.toThrow();
  });

  it("refuses a sign-in that doesn't grant use of the plan", async () => {
    const ctx = setup({ scope: "openid profile email offline_access" });
    const { page, view } = await signIn(ctx);
    expect(page.body).toContain("Go back to Mivra to try again");
    expect(view).toMatchObject({ signedIn: false, notice: expect.stringContaining("didn't grant Mivra use of your plan") });
    expect(ctx.store.current()?.tokens ?? null).toBeNull();
  });

  it("refuses an ID token with the wrong nonce or signature", async () => {
    const ctx = setup();
    ctx.auth.state.nonceOverride = "another-nonce";
    expect((await signIn(ctx)).view).toMatchObject({ signedIn: false, notice: expect.stringContaining("couldn't be verified") });

    const forged = setup();
    forged.auth.state.idTokenKey = forgingKey;
    expect((await signIn(forged)).view.signedIn).toBe(false);
  });

  it("reports a declined sign-in", async () => {
    const ctx = setup();
    const started = await ctx.session.startSignIn();
    const back = new URL(new URL(started.url).searchParams.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", new URL(started.url).searchParams.get("state")!);
    await visit(back.toString());
    expect(await started.done).toMatchObject({ signedIn: false, notice: expect.stringContaining("wasn't completed") });
  });

  it("finishes from a pasted address when the browser can't reach this machine", async () => {
    const ctx = setup();
    const started = await ctx.session.startSignIn();
    const back = ctx.auth.approve(started.url);
    await expect(ctx.session.completeSignIn("https://example.com/nothing")).rejects.toThrow("isn't the address");
    const other = new URL(back);
    other.searchParams.set("state", "other");
    await expect(ctx.session.completeSignIn(other.toString())).rejects.toThrow("different sign-in");
    expect(await ctx.session.completeSignIn(`  ${back}\n`)).toMatchObject({ signedIn: true, email: "learner@example.com" });
    expect((await started.done).signedIn).toBe(true);
    await expect(ctx.session.completeSignIn(back)).rejects.toThrow("No sign-in is waiting");
  });

  it("refuses a discovery document that sends tokens to another origin", async () => {
    const ctx = setup({ discovery: { token_endpoint: "https://attacker.example/token" } });
    await expect(ctx.session.startSignIn()).rejects.toThrow("couldn't be verified");
  });

  it("reuses the saved registration after signing out, and won't switch accounts on it", async () => {
    const ctx = setup();
    await signIn(ctx);
    expect(await ctx.session.signOut()).toEqual({ revoked: true });
    expect(ctx.auth.state.revoked).toEqual(["refresh-1"]);
    expect(ctx.session.view()).toMatchObject({ signedIn: false, previous: "learner@example.com" });
    await expect(ctx.session.accessToken()).rejects.toThrow("Sign in with ChatGPT");

    const again = await ctx.session.startSignIn();
    const url = new URL(again.url);
    expect(url.searchParams.get("client_id")).toBe("oaiapp_first");
    expect(url.searchParams.get("login_hint")).toBe("learner@example.com");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    ctx.auth.state.subject = "someone-else";
    await visit(ctx.auth.approve(again.url, { includeClientId: false }));
    expect(await again.done).toMatchObject({ signedIn: false, notice: expect.stringContaining("different account") });

    // "Use a different account" registers afresh.
    const fresh = await ctx.session.startSignIn({ newAccount: true });
    expect(new URL(fresh.url).searchParams.get("client_id")).toBe("dynamic_agent_client");
    await visit(ctx.auth.approve(fresh.url, { clientId: "oaiapp_second" }));
    expect((await fresh.done).signedIn).toBe(true);
    expect(ctx.store.current()!.registration).toMatchObject({ clientId: "oaiapp_second", subject: "someone-else" });
  });

  it("writes chatgpt.json with mode 0600", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mivra-chatgpt-"));
    dirs.push(dataDir);
    const auth = fakeAuth();
    const session = createChatGptSession({ store: chatGptFileStore(dataDir), oauth: createOAuthClient({ fetch: auth.fetch }), callbackPort: 0 });
    sessions.push(session);
    const started = await session.startSignIn();
    await visit(auth.approve(started.url));
    expect((await started.done).signedIn).toBe(true);
    expect(statSync(join(dataDir, CHATGPT_FILE)).mode & 0o777).toBe(0o600);
    // Another reader of the same file (the CLI, or a restarted server) sees the sign-in.
    expect(createChatGptSession({ store: chatGptFileStore(dataDir) }).view()).toMatchObject({ signedIn: true, email: "learner@example.com" });
  });
});

describe("keeping the ChatGPT token fresh", () => {
  const signedIn = (expiresAt: number): ChatGptFile => ({
    version: 1,
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000000",
    registration: { clientId: "oaiapp_first", subject: "user-1", email: "learner@example.com", name: null },
    tokens: { accessToken: "access-1", refreshToken: "refresh-1", expiresAt, scopes: DIRECT.split(" "), idToken: "x.y.z" },
    notice: null,
    welcomed: true,
  });

  it("renews a token close to expiry once, however many runs ask, and saves the rotated refresh token", async () => {
    const ctx = setup({}, { initial: signedIn(Date.now() + 60_000) });
    const tokens = await Promise.all([ctx.session.accessToken(), ctx.session.accessToken(), ctx.session.accessToken()]);
    expect(tokens).toEqual(["access-2", "access-2", "access-2"]);
    expect(ctx.auth.state.refreshes).toBe(1);
    expect(ctx.store.current()!.tokens).toMatchObject({ refreshToken: "refresh-2", accessToken: "access-2" });
    expect(await ctx.session.accessToken()).toBe("access-2");
    expect(ctx.auth.state.refreshes).toBe(1);
  });

  it("signs the learner out when the session can't be renewed", async () => {
    const ctx = setup({}, { initial: signedIn(Date.now() - 1000) });
    ctx.auth.state.refreshError = "refresh_token_expired";
    await expect(ctx.session.accessToken()).rejects.toThrow("expired");
    expect(ctx.session.view()).toMatchObject({ signedIn: false, previous: "learner@example.com", notice: expect.stringContaining("Sign in again") });
  });

  it("keeps the session through a passing outage", async () => {
    const ctx = setup({}, { initial: signedIn(Date.now() - 1000) });
    ctx.auth.state.refreshError = "temporarily_unavailable";
    await expect(ctx.session.accessToken()).rejects.toThrow();
    expect(ctx.session.view().signedIn).toBe(true);
  });
});

describe("the ChatGPT model provider", () => {
  it("calls the Responses API with the fresh token, stores nothing, and sends instructions as a developer message", async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown>; redirect?: RequestRedirect }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), redirect: init?.redirect });
      return json({ error: { message: "stop here" } }, 400);
    };
    const registry = createRegistry({ chatgptToken: async () => "plan-token", fetch: fakeFetch });
    for (const model of ["chatgpt:gpt-6.1-sol", "chatgpt:some-future-model"]) {
      const result = streamText({ model: resolveModel(model, registry), ...callOptionsFor({ model, effort: "high" }), instructions: "Teach well.", prompt: "hi", maxRetries: 0 });
      await result.consumeStream({ onError: () => {} });
    }
    for (const request of requests) {
      expect(request.url).toBe(`${CHATGPT_API}/responses`);
      expect(request.headers.get("authorization")).toBe("Bearer plan-token");
      expect(request.headers.has("openai-organization")).toBe(false);
      expect(request.redirect).toBe("error");
      expect(request.body).toMatchObject({ store: false, stream: true });
      expect(JSON.stringify(request.body.input)).not.toContain('"role":"system"');
      for (const field of ["temperature", "max_output_tokens", "previous_response_id", "metadata"]) expect(request.body).not.toHaveProperty(field);
    }
    expect(requests[0]!.body.model).toBe("gpt-6.1-sol");
    expect(requests[0]!.body.reasoning).toMatchObject({ effort: "high" });
  });

  it("fails a run with a message to sign in when there's no sign-in", async () => {
    let failure: unknown;
    const registry = createRegistry({ chatgptToken: () => createChatGptSession({ store: memoryChatGptStore() }).accessToken() });
    await streamText({ model: resolveModel("chatgpt:gpt-6.1-sol", registry), prompt: "hi", maxRetries: 0, onError: ({ error }) => (failure = error) }).consumeStream();
    expect(publicErrorText(failure)).toBe("Sign in with ChatGPT under Model providers first.");
  });

  it("explains plan usage limits in Mivra's words", () => {
    const error = new APICallError({
      message: "provider text",
      url: `${CHATGPT_API}/responses`,
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "echo of the request" } }),
    });
    expect(publicErrorText(error)).toBe(CHATGPT_USAGE_LIMIT_ERROR);
    expect(publicErrorText({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } })).toContain("Try again shortly");
  });

  it("prefers ChatGPT as the default once the learner signs in", () => {
    expect(defaultSelectionFor({ openrouter: "k" }, true)).toEqual(CHATGPT_DEFAULT);
    expect(defaultSelectionFor({ openrouter: "k" }, false).model).toMatch(/^openrouter:/);
  });
});

describe("the ChatGPT model list", () => {
  it("keeps listed models and describes them by their OpenRouter counterpart, without a price", () => {
    const models = parseChatGptModels({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
        { slug: "internal-only", display_name: "Hidden", visibility: "hide" },
        { slug: "gpt-6.1-sol", display_name: "Duplicate", visibility: "list" },
        { slug: "brand-new", display_name: "Brand New", visibility: "list" },
        { nonsense: true },
      ],
    });
    expect(models).toEqual([{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }, { slug: "brand-new", name: "Brand New" }]);
    const openrouter: CatalogModel[] = [
      { id: "openrouter:openai/gpt-6.1-sol", name: "OpenAI: GPT-6.1 Sol", contextLength: 400_000, price: { input: 1, output: 8 }, reasoning: { efforts: ["low", "high"], defaultEffort: "low" } },
    ];
    expect(describeChatGptModels(models, openrouter)).toEqual([
      { id: "chatgpt:gpt-6.1-sol", name: "GPT-6.1 Sol", contextLength: 400_000, price: null, reasoning: { efforts: ["low", "high"], defaultEffort: "low" } },
      { id: "chatgpt:brand-new", name: "Brand New", contextLength: null, price: null, reasoning: null },
    ]);
  });
});

describe("ChatGPT sign-in routes", () => {
  const TOKEN = "test-token";
  const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const appWith = (session: ChatGptSession | undefined, local = true) =>
    createApp({
      db: openDb(":memory:"),
      model: () => new MockLanguageModelV4(),
      security: { token: TOKEN, allowedHosts: [] },
      providers: { credentials: memoryCredentials(), isLocal: () => local, chatgpt: session },
    });

  it("start a sign-in and show its progress, without ever returning a token", async () => {
    const ctx = setup();
    const app = appWith(ctx.session);
    const start = await app.request("/api/settings/chatgpt/sign-in", { method: "POST", headers, body: "{}" });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    expect((await (await app.request("/api/settings/providers", { headers })).json()).chatgpt).toMatchObject({ signedIn: false, pending: true });
    await visit(ctx.auth.approve(url));
    const text = await (await app.request("/api/settings/providers", { headers })).text();
    expect(JSON.parse(text).chatgpt).toMatchObject({ signedIn: true, pending: false, email: "learner@example.com" });
    expect(text).not.toContain("access-1");
    expect(text).not.toContain("refresh-1");
    const out = await app.request("/api/settings/chatgpt", { method: "DELETE", headers });
    expect((await out.json()).chatgpt).toMatchObject({ signedIn: false, previous: "learner@example.com" });
  });

  it("let a browser on another machine sign in by pasting the address back, and welcome the learner once", async () => {
    const ctx = setup();
    // Not loopback: a tailnet browser, which the host guard already let in.
    const app = appWith(ctx.session, false);
    const start = await app.request("/api/settings/chatgpt/sign-in", { method: "POST", headers, body: "{}" });
    expect(start.status).toBe(200);
    const back = ctx.auth.approve(((await start.json()) as { url: string }).url);
    const done = await app.request("/api/settings/chatgpt/sign-in/complete", { method: "POST", headers, body: JSON.stringify({ address: back }) });
    const view = (await done.json()) as { canEdit: boolean; chatgpt: { signedIn: boolean; welcome: boolean } };
    // Keys stay local-only (ADR-013); the ChatGPT sign-in doesn't (ADR-015).
    expect(view.canEdit).toBe(false);
    expect(view.chatgpt).toMatchObject({ signedIn: true, welcome: true });
    const welcomed = await app.request("/api/settings/chatgpt/welcomed", { method: "POST", headers });
    expect((await welcomed.json()).chatgpt.welcome).toBe(false);
    await ctx.session.signOut();
    // Signing in again later doesn't show it again.
    const again = await ctx.session.startSignIn();
    await ctx.session.completeSignIn(ctx.auth.approve(again.url));
    expect(ctx.session.view()).toMatchObject({ signedIn: true, welcome: false });
  });

  it("answer 404 when the server doesn't offer sign-in with ChatGPT", async () => {
    const app = appWith(undefined);
    expect((await app.request("/api/settings/chatgpt/sign-in", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await (await app.request("/api/settings/providers", { headers })).json()).chatgpt).toBeNull();
  });
});
