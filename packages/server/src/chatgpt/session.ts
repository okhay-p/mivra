import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { CALLBACK_PATH, ChatGptError, TERMINAL_REFRESH_ERRORS, createOAuthClient, readCallback, type Authorization, type OAuthClient, type Tokens } from "./oauth.js";

export const CHATGPT_FILE = "chatgpt.json";
/** The callback port OpenAI's examples use. Any port works; this one is tried first. */
export const CALLBACK_PORT = 1455;
/** How long a sign-in waits for the browser to come back. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
/** Access tokens last an hour; one with less than this left is renewed before it's used. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SIGNED_OUT = "Sign in with ChatGPT under Model providers first.";

const TokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
  idToken: z.string().min(1),
});

const FileSchema = z.object({
  version: z.literal(1),
  /** Sent as `ext_agent_host_id`: made once per install, never a secret. */
  hostId: z.string().min(1).max(200),
  /** The client id ChatGPT issued for this account, kept after sign-out so signing in again reuses it. */
  registration: z.object({ clientId: z.string().min(1), subject: z.string().min(1), email: z.string().nullable(), name: z.string().nullable() }).nullable(),
  tokens: TokensSchema.nullable(),
  /** Why the learner was signed out, when Mivra did it (an expired session, say). */
  notice: z.string().nullable(),
  /** The one-time "You're using your ChatGPT plan" dialog has been shown (OpenAI's guidelines: once, ever). */
  welcomed: z.boolean().default(false),
});
export type ChatGptFile = z.infer<typeof FileSchema>;

export interface ChatGptFileStore {
  load(): ChatGptFile | undefined;
  save(file: ChatGptFile): void;
}

/** `chatgpt.json` in the data dir: mode 0600, written atomically, read fresh on every use (ADR-015). */
export function chatGptFileStore(dataDir: string): ChatGptFileStore {
  const path = join(dataDir, CHATGPT_FILE);
  let warned = false;
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      const parsed = FileSchema.safeParse((() => {
        try {
          return JSON.parse(text);
        } catch {
          return undefined;
        }
      })());
      if (parsed.success) return parsed.data;
      if (!warned) console.warn(`${path} isn't valid, so the ChatGPT sign-in in it is ignored. Sign in again to replace it.`);
      warned = true;
      return undefined;
    },
    save(file) {
      mkdirSync(dataDir, { recursive: true });
      const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, path);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}

/** A file store held in memory, for tests. */
export function memoryChatGptStore(initial?: ChatGptFile): ChatGptFileStore & { current(): ChatGptFile | undefined } {
  let file = initial && structuredClone(initial);
  return { load: () => file && structuredClone(file), save: (next) => (file = structuredClone(next)), current: () => file };
}

/** What a client may know about the ChatGPT sign-in. Never a token. */
export interface ChatGptView {
  signedIn: boolean;
  email: string | null;
  name: string | null;
  /** A sign-in is waiting for the browser. */
  pending: boolean;
  /** An account signed in before, which "Sign in" reuses. */
  previous: string | null;
  /** Why the last sign-in failed or the learner was signed out. */
  notice: string | null;
  /** Signed in, and the one-time welcome hasn't been shown yet. */
  welcome: boolean;
}

export interface StartedSignIn {
  url: string;
  redirectUri: string;
  /** Settles when this sign-in finishes, fails, times out or is cancelled. */
  done: Promise<ChatGptView>;
}

export interface ChatGptSessionOptions {
  store: ChatGptFileStore;
  oauth?: OAuthClient;
  clock?: () => number;
  /** First port to listen on for the callback; 0 picks any free one. Falls back to any free port when taken. */
  callbackPort?: number;
  signInTimeoutMs?: number;
}

interface Pending {
  auth: Authorization;
  server: Server;
  settled: boolean;
  finish(result: ChatGptView): void;
  timer: NodeJS.Timeout;
}

/**
 * The learner's ChatGPT sign-in (ADR-015): starting and finishing it, keeping the access token fresh, and
 * signing out. Only the server's own process refreshes; it does so one refresh at a time.
 */
export function createChatGptSession({ store, oauth = createOAuthClient(), clock = Date.now, callbackPort = CALLBACK_PORT, signInTimeoutMs = SIGN_IN_TIMEOUT_MS }: ChatGptSessionOptions) {
  let pending: Pending | undefined;
  let refreshing: Promise<string> | undefined;
  /** The last sign-in's failure, until the next one starts. */
  let lastError: string | null = null;

  const load = (): ChatGptFile => store.load() ?? { version: 1, hostId: `urn:uuid:${randomUUID()}`, registration: null, tokens: null, notice: null, welcomed: false };
  const save = (file: ChatGptFile) => store.save(file);

  function view(): ChatGptView {
    const file = store.load();
    const signedIn = Boolean(file?.tokens && file.registration);
    return {
      signedIn,
      email: signedIn ? file!.registration!.email : null,
      name: signedIn ? file!.registration!.name : null,
      pending: pending !== undefined && !pending.settled,
      previous: !signedIn && file?.registration ? file.registration.email ?? "your previous account" : null,
      notice: lastError ?? (signedIn ? null : file?.notice ?? null),
      welcome: signedIn && !file!.welcomed,
    };
  }

  function endSession(notice: string) {
    const file = load();
    save({ ...file, tokens: null, notice });
  }

  async function refresh(): Promise<string> {
    // Read again: the CLI may have signed in or out since this refresh was asked for.
    const file = load();
    if (!file.tokens || !file.registration) throw new ChatGptError("signed_out", SIGNED_OUT);
    if (file.tokens.expiresAt - clock() > REFRESH_MARGIN_MS) return file.tokens.accessToken;
    const { clientId, subject } = file.registration;
    let tokens: Tokens;
    try {
      tokens = await oauth.refresh(clientId, file.tokens);
    } catch (error) {
      if (error instanceof ChatGptError && (TERMINAL_REFRESH_ERRORS.has(error.code) || error.code === "scope_not_granted")) endSession(error.message);
      throw error;
    }
    // The old refresh token is spent: save the new one before anything else can fail.
    save({ ...load(), tokens, notice: null });
    if (tokens.idToken !== file.tokens.idToken) {
      try {
        const identity = await oauth.verifyIdToken(tokens.idToken, clientId);
        if (identity.subject !== subject) throw new ChatGptError("account_mismatch", "ChatGPT renewed the sign-in for a different account.");
      } catch (error) {
        // An unreachable key service doesn't make the tokens wrong; a bad or foreign identity does.
        if (!(error instanceof ChatGptError) || error.retryable) return tokens.accessToken;
        endSession("ChatGPT's renewed sign-in couldn't be verified. Sign in again under Model providers.");
        throw error;
      }
    }
    return tokens.accessToken;
  }

  /** Finishes the pending sign-in from a validated callback. Never throws: failures land in the view. */
  async function finish(current: Pending, callback: { code: string; clientId: string }): Promise<ChatGptView> {
    try {
      const { tokens, identity } = await oauth.exchange(current.auth, callback);
      const file = load();
      if (current.auth.clientId && file.registration && file.registration.subject !== identity.subject) {
        throw new ChatGptError("account_mismatch", `You signed in to a different account than ${file.registration.email ?? "before"}. To switch accounts, choose "Use a different account".`);
      }
      save({ ...file, registration: { clientId: callback.clientId, subject: identity.subject, email: identity.email, name: identity.name }, tokens, notice: null });
      lastError = null;
    } catch (error) {
      lastError = error instanceof ChatGptError ? error.message : "Sign-in with ChatGPT failed. Try again.";
    }
    const result = { ...view(), pending: false };
    current.finish(result);
    return result;
  }

  /** Stops listening. A reply being written still goes out; idle browser connections are dropped. */
  function close(current: Pending) {
    current.settled = true;
    clearTimeout(current.timer);
    current.server.close();
    current.server.closeIdleConnections();
    if (pending === current) pending = undefined;
  }

  async function listen(server: Server): Promise<number> {
    for (const port of callbackPort === 0 ? [0] : [callbackPort, 0]) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ port, host: "127.0.0.1" }, () => {
            server.off("error", reject);
            resolve();
          });
        });
        return (server.address() as AddressInfo).port;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new ChatGptError("callback_port_unavailable", "Mivra couldn't listen for ChatGPT's answer. Try again.");
  }

  return {
    view,

    /** Changes when the learner signs in to another account or out, so what depends on the account can rebuild. */
    signature(): string {
      const file = store.load();
      return file?.tokens && file.registration ? file.registration.subject : "";
    },

    /** A valid access token, renewed first when it's close to expiring. Throws a ChatGptError when signed out. */
    accessToken(): Promise<string> {
      const file = store.load();
      if (!file?.tokens || !file.registration) return Promise.reject(new ChatGptError("signed_out", SIGNED_OUT));
      if (file.tokens.expiresAt - clock() > REFRESH_MARGIN_MS) return Promise.resolve(file.tokens.accessToken);
      refreshing ??= refresh().finally(() => (refreshing = undefined));
      return refreshing;
    },

    /**
     * Starts a sign-in: listens on 127.0.0.1 for the callback and returns the URL to open. A sign-in already
     * waiting is cancelled. `newAccount` registers afresh instead of reusing the saved registration.
     */
    async startSignIn({ newAccount = false }: { newAccount?: boolean } = {}): Promise<StartedSignIn> {
      if (pending) close(pending);
      lastError = null;
      const file = load();
      // Make the host id once, before the first authorize request names it.
      if (!store.load()) save(file);
      const registration = newAccount ? null : file.registration;
      let resolveDone!: (view: ChatGptView) => void;
      const done = new Promise<ChatGptView>((resolve) => (resolveDone = resolve));
      const server = createServer();
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      const port = await listen(server);
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      let auth: Authorization;
      try {
        auth = await oauth.authorize({ redirectUri, hostId: file.hostId, clientId: registration?.clientId, loginHint: registration?.email });
      } catch (error) {
        server.close();
        throw error;
      }
      const current: Pending = {
        auth,
        server,
        settled: false,
        finish: resolveDone,
        timer: setTimeout(() => {
          if (current.settled) return;
          lastError = "Sign-in timed out. Start it again when you're ready.";
          close(current);
          resolveDone(view());
        }, signInTimeoutMs),
      };
      current.timer.unref();
      pending = current;

      server.on("request", (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
        const url = new URL(request.url ?? "/", redirectUri);
        // Only the browser coming back to this exact address; anything else on the port is ignored.
        if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH || current.settled) {
          response.writeHead(404).end("Not found");
          return;
        }
        const callback = readCallback(url.searchParams, auth);
        if (callback === "wrong-state") {
          response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("This sign-in link is out of date", "Go back to Mivra and start signing in again."));
          return;
        }
        const reply = (result: ChatGptView) =>
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
            result.signedIn
              ? page("Signed in to ChatGPT", "Mivra can now use your ChatGPT plan. You can close this tab and go back to Mivra.")
              : page("Sign-in didn't finish", `${result.notice ?? "Something went wrong."} Go back to Mivra to try again.`),
          );
        if (!callback.ok) {
          lastError = callback.error.message;
          close(current);
          const result = view();
          resolveDone(result);
          reply(result);
          return;
        }
        // Settle at once so a second request can't exchange the same code.
        current.settled = true;
        void finish(current, callback).then((result) => {
          reply(result);
          close(current);
        });
      });
      return { url: auth.url, redirectUri, done };
    },

    /**
     * Finishes the pending sign-in from the address the browser ended on, for when the browser can't reach this
     * machine's 127.0.0.1 (Mivra on another computer, or in Docker).
     */
    async completeSignIn(address: string): Promise<ChatGptView> {
      const current = pending;
      if (!current || current.settled) throw new ChatGptError("no_sign_in", "No sign-in is waiting. Start one first.");
      let params: URLSearchParams;
      try {
        const trimmed = address.trim();
        params = trimmed.startsWith("http") ? new URL(trimmed).searchParams : new URLSearchParams(trimmed.replace(/^[^?]*\?/, ""));
      } catch {
        throw new ChatGptError("bad_address", "That isn't the address from the browser. Copy the whole address after approving.");
      }
      const callback = readCallback(params, current.auth);
      if (callback === "wrong-state") {
        throw new ChatGptError("wrong_state", params.has("state") ? "That address is from a different sign-in. Use the one from the sign-in you just started." : "That isn't the address from the browser. Copy the whole address after approving.");
      }
      if (!callback.ok) {
        lastError = callback.error.message;
        close(current);
        const result = view();
        current.finish(result);
        return result;
      }
      current.settled = true;
      try {
        return await finish(current, callback);
      } finally {
        close(current);
      }
    },

    cancelSignIn() {
      const current = pending;
      if (!current) return;
      close(current);
      current.finish(view());
    },

    /** Signs out: ends the session at OpenAI and forgets the tokens, keeping the registration for next time. */
    async signOut(): Promise<{ revoked: boolean }> {
      const file = store.load();
      if (!file?.tokens || !file.registration) return { revoked: true };
      save({ ...file, tokens: null, notice: null });
      const revoked = await oauth.revoke(file.registration.clientId, file.tokens.refreshToken);
      lastError = revoked ? null : "Signed out of Mivra, but ChatGPT didn't confirm it. To be sure, disconnect Mivra in ChatGPT's settings.";
      return { revoked };
    },

    /** Records that the welcome dialog was shown, so it never shows again. */
    welcomed() {
      const file = store.load();
      if (file && !file.welcomed) save({ ...file, welcomed: true });
    },

    /** Stops listening for a callback; for shutdown and tests. */
    close() {
      if (pending) close(pending);
    },
  };
}

export type ChatGptSession = ReturnType<typeof createChatGptSession>;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mivra</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1f1b16;background:#faf7f2}h1{font-size:1.4rem}@media (prefers-color-scheme:dark){body{color:#ece6dc;background:#1b1916}}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}
