import { createHash } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, stepCountIs, streamText, tool, wrapLanguageModel, type LanguageModel } from "ai";
import { z } from "zod";
import { ApiKey, type CredentialStore } from "../credentials.js";
import type { ModelSelection } from "../model.js";
import type { SettingsStore } from "../store/settings-store.js";
import type { CatalogModel } from "./catalog.js";

/**
 * Custom OpenAI-compatible providers (issue #69, ADR-012, ADR-013): a learner-named service reached through its
 * Chat Completions API at a base URL they enter. The non-secret configuration lives in SQLite settings; keys live in
 * the credential store under `custom:<id>`, never in the database.
 *
 * Identity: each provider gets a stable id when it's created, made from its first name and never reused, even after
 * it's removed. Its models are `custom:<provider id>/<model id>`, so renaming a provider changes no model's identity,
 * the same model id on two providers stays two models, and a removed provider's runs keep their provenance.
 */

export const CUSTOM_PREFIX = "custom:";

/** Limits on what's configured and what a provider's list may hold. */
export const MAX_CUSTOM_PROVIDERS = 20;
export const MAX_CUSTOM_MODELS = 200;
const MAX_DISCOVERED = 2000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const LIST_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

const SETTINGS_KEY = "providers.custom";
const discoveryKey = (id: string) => `providers.custom.${id}.discovery`;
const verificationKey = (id: string) => `providers.custom.${id}.verification`;

/** Stable provider ids: lower-case letters, digits and dashes, starting with a letter. */
export const CustomProviderId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "Unknown provider");

export const ProviderName = z
  .string()
  .trim()
  .min(1, "Give the provider a name")
  .max(60, "Keep the name under 60 characters")
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "The name can't contain control characters");

/**
 * A model id as the provider names it. Printable ASCII without spaces, short enough that `custom:<provider>/<id>`
 * fits a selection (200 characters).
 */
export const CustomModelId = z
  .string()
  .trim()
  .min(1, "Enter a model id")
  .max(150, "That model id is too long")
  .regex(/^[\x21-\x7e]+$/, "A model id has no spaces or special characters");

const Limit = z.number().int().positive().max(100_000_000).nullable();

/** A model the learner configured. Limits are what the learner entered under Advanced; Mivra never guesses them. */
export const CustomModelInput = z.object({
  id: CustomModelId,
  contextLength: Limit.optional(),
  maxOutputTokens: Limit.optional(),
});
export type CustomModelInput = z.infer<typeof CustomModelInput>;

const StoredModel = z.object({ id: z.string(), contextLength: z.number().nullable(), maxOutputTokens: z.number().nullable() });
type StoredModel = z.infer<typeof StoredModel>;

const StoredProvider = z.object({
  id: CustomProviderId,
  name: z.string(),
  /** Saved in the UI. Null means the environment's, if any. */
  baseUrl: z.string().nullable(),
  models: z.array(StoredModel),
});
type StoredProvider = z.infer<typeof StoredProvider>;

const StoredSettings = z.object({
  providers: z.array(StoredProvider).default([]),
  /** Names of removed providers by id: their ids are never reused, and old replies still name them. */
  removed: z.record(z.string(), z.string()).default({}),
});
type StoredSettings = z.infer<typeof StoredSettings>;

const StoredDiscovery = z.object({
  /** The URL and key the list came from (see `fingerprint`). Another URL or key makes it no longer apply. */
  fingerprint: z.string(),
  ids: z.array(z.string()),
  fetchedAt: z.number().nullable(),
  error: z.string().nullable(),
});

const StoredVerification = z.record(
  z.string(),
  z.object({ fingerprint: z.string(), status: z.enum(["verified", "failed"]), message: z.string().nullable(), at: z.number() }),
);

/** The environment variables that can set a custom provider's base URL and key, by its id. */
export function customProviderEnv(id: string) {
  const stem = `MIVRA_PROVIDER_${id.toUpperCase().replace(/-/g, "_")}`;
  return { baseUrl: `${stem}_BASE_URL`, key: `${stem}_API_KEY` };
}

/** The credential store's name for a custom provider's key. */
export const customKeyName = (id: string) => `${CUSTOM_PREFIX}${id}`;

export class CustomProviderError extends Error {
  /** Messages are Mivra's own, so they're safe to show a client. */
  constructor(message: string) {
    super(message);
    this.name = "CustomProviderError";
  }
}

/**
 * Validates an API base URL: http or https, no credentials, query or fragment (a URL is stored as a non-secret, and a
 * query could carry a key), and the base rather than a full endpoint. Returns it without a trailing slash, keeping any
 * path prefix such as `/v1` or `/inference/go/openai/v1`. Loopback and LAN addresses are fine: local servers count.
 */
export function parseBaseUrl(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const text = input.trim();
  if (!text) return { ok: false, message: "Enter the API base URL" };
  if (text.length > 500) return { ok: false, message: "That URL is too long" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "Enter a full URL, such as https://api.example.com/v1" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, message: "The URL must start with https:// or http://" };
  if (url.username || url.password) return { ok: false, message: "Don't put a user name or password in the URL. Enter the key in its own field." };
  if (text.includes("?") || text.includes("#")) return { ok: false, message: "The URL can't have a query (?…) or fragment (#…). Enter the key in its own field." };
  const path = url.pathname.replace(/\/+$/, "");
  const endpoint = /\/(chat\/completions|completions|responses|models|embeddings)$/i.exec(path);
  if (endpoint) {
    return { ok: false, message: `Enter the API base, not the /${endpoint[1]} endpoint: drop "/${endpoint[1]}" from the end.` };
  }
  return { ok: true, url: `${url.origin}${path}` };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Identifies an endpoint without naming it: recorded with runs so reasoning never replays to another destination. */
export const endpointFingerprint = (baseUrl: string) => sha(`endpoint\n${baseUrl}`);

/**
 * Identifies a URL and key pair, so a discovered list or a test result stops applying when either changes. Stored in
 * SQLite: it's a truncated hash, from which the key can't be recovered.
 */
const credentialFingerprint = (baseUrl: string, key: string | undefined) => sha(`credential\n${baseUrl}\n${key ?? ""}`);

/** A custom model's id in the picker: `custom:<provider>/<model>`. */
export const customModelId = (providerId: string, modelId: string) => `${CUSTOM_PREFIX}${providerId}/${modelId}`;

/** Splits `custom:<provider>/<model>`; undefined for anything else. */
export function parseCustomModelId(id: string): { providerId: string; modelId: string } | undefined {
  if (!id.startsWith(CUSTOM_PREFIX)) return undefined;
  const rest = id.slice(CUSTOM_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 1) return undefined;
  const providerId = rest.slice(0, slash);
  const modelId = rest.slice(slash + 1);
  return CustomProviderId.safeParse(providerId).success && modelId ? { providerId, modelId } : undefined;
}

export type Verification = { status: "unverified" | "verified" | "failed"; message: string | null; at: string | null };

/** What a client may know about a custom provider: never its key. */
export interface CustomProviderView {
  id: string;
  name: string;
  baseUrl: {
    /** The URL in use, or null when there's none. */
    value: string | null;
    source: "saved" | "env" | null;
    /** The environment's URL, when set, so the UI can offer to go back to it. */
    env: string | null;
    /** Set when the environment's URL isn't valid, so it isn't used. */
    error: string | null;
  };
  key: { source: "env" | "saved" | null; hint: string | null };
  /** The environment variables that may set its URL and key. */
  envNames: { baseUrl: string; key: string };
  models: { id: string; modelId: string; contextLength: number | null; maxOutputTokens: number | null; verification: Verification }[];
  discovery: { state: "none" | "fresh" | "stale" | "failed"; ids: string[]; error: string | null; fetchedAt: string | null };
}

export type TestResult =
  | { ok: true; message: string }
  | { ok: false; reason: "auth" | "endpoint" | "model" | "tools" | "streaming" | "unreachable" | "timeout" | "cancelled" | "other"; message: string };

export interface CustomProviderOptions {
  settings: SettingsStore;
  credentials: CredentialStore;
  /** Reads an environment variable: a provider's base URL and key may come from there. */
  env?: (name: string) => string | undefined;
  fetch?: typeof fetch;
  clock?: () => number;
}

interface Resolved {
  provider: StoredProvider;
  baseUrl: string | null;
  baseUrlSource: "saved" | "env" | null;
  envUrl: string | null;
  envUrlError: string | null;
  key: string | undefined;
  keySource: "env" | "saved" | null;
}

const hintFor = (key: string) => (key.length >= 12 ? key.slice(-4) : null);

/** Removes a key, and anything that looks like a bearer token, from text a provider sent back. Keeps its length and layout. */
function redact(text: string, key: string | undefined): string {
  let out = text;
  if (key) out = out.split(key).join("[key]");
  return out.replace(/Bearer\s+\S+/gi, "Bearer [key]").replace(/\b(sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "[key]");
}

/** `redact`, cut to a short single line for a message the learner sees. */
function scrub(text: string, key: string | undefined): string {
  return redact(text, key).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}

/**
 * The same error with the key taken out of its message and the provider's response body, so neither the SDK's
 * logging nor `runs.error` can carry it (a provider may echo the key back, e.g. in a 401 body).
 */
function redactedError(error: unknown, key: string | undefined): unknown {
  if (APICallError.isInstance(error)) {
    return new APICallError({
      message: redact(error.message, key),
      url: error.url,
      requestBodyValues: error.requestBodyValues,
      statusCode: error.statusCode,
      responseHeaders: error.responseHeaders,
      responseBody: error.responseBody === undefined ? undefined : redact(error.responseBody, key),
      isRetryable: error.isRetryable,
    });
  }
  if (error instanceof Error) {
    const clean = new Error(redact(error.message, key));
    clean.name = error.name;
    return clean;
  }
  if (typeof error === "string") return redact(error, key);
  // A streamed `{"error":{"message":…}}` arrives as a plain object, which the SDK turns into an error's message later.
  if (error && typeof error === "object") {
    try {
      return JSON.parse(redact(JSON.stringify(error), key)) as unknown;
    } catch {
      return { message: "The provider sent an error Mivra couldn't read." };
    }
  }
  return error;
}

/** The provider's own error message, when its body has one: `{ error: { message } }`, `{ error: "…" }` or `{ message }`. */
function providerMessage(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : parsed.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new CustomProviderError("The model list is too large to read.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The ids in a `/models` answer: OpenAI's `{ data: [{ id }] }`, or a bare array. Invalid ids are skipped; duplicates dropped. */
export function parseModelList(body: unknown): string[] {
  const data = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new CustomProviderError("The model list isn't in the expected format (no data array).");
  const seen = new Set<string>();
  for (const entry of data) {
    if (seen.size >= MAX_DISCOVERED) break;
    const id = CustomModelId.safeParse((entry as { id?: unknown } | null)?.id);
    if (id.success) seen.add(id.data);
  }
  return [...seen];
}

/** A slug for a new provider's id, from its name. */
function slug(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return /^[a-z]/.test(base) ? base : `provider${base ? `-${base}` : ""}`.slice(0, 24);
}

export function createCustomProviders({ settings, credentials, env = () => undefined, fetch: fetchImpl = fetch, clock = Date.now }: CustomProviderOptions) {
  const load = (): StoredSettings => {
    const parsed = StoredSettings.safeParse(settings.get(SETTINGS_KEY) ?? {});
    return parsed.success ? parsed.data : { providers: [], removed: {} };
  };
  const save = (value: StoredSettings) => settings.set(SETTINGS_KEY, value);

  function resolve(provider: StoredProvider): Resolved {
    const names = customProviderEnv(provider.id);
    const rawEnvUrl = env(names.baseUrl)?.trim() || null;
    const envParsed = rawEnvUrl ? parseBaseUrl(rawEnvUrl) : undefined;
    const envUrl = envParsed?.ok ? envParsed.url : null;
    const envUrlError = envParsed && !envParsed.ok ? `${names.baseUrl} isn't used: ${envParsed.message}` : null;
    // A URL saved in the UI wins over the environment's (issue #69); there's no built-in default.
    const baseUrl = provider.baseUrl ?? envUrl;
    const { key, source: keySource } = credentials.customKey(provider.id, names.key);
    return {
      provider,
      baseUrl,
      baseUrlSource: provider.baseUrl ? "saved" : envUrl ? "env" : null,
      // Only a URL that passed validation: a rejected one may hold credentials (user:pass@ or ?api_key=).
      envUrl,
      envUrlError,
      key,
      keySource,
    };
  }

  const find = (id: string) => load().providers.find((p) => p.id === id);

  function verifications(resolved: Resolved): Record<string, Verification> {
    const stored = StoredVerification.safeParse(settings.get(verificationKey(resolved.provider.id)));
    const fingerprint = resolved.baseUrl ? credentialFingerprint(resolved.baseUrl, resolved.key) : undefined;
    const out: Record<string, Verification> = {};
    for (const m of resolved.provider.models) {
      const v = stored.success ? stored.data[m.id] : undefined;
      // A test of another URL or key says nothing about this one.
      out[m.id] = v && v.fingerprint === fingerprint
        ? { status: v.status, message: v.message, at: new Date(v.at).toISOString() }
        : { status: "unverified", message: null, at: null };
    }
    return out;
  }

  function discoveryView(resolved: Resolved): CustomProviderView["discovery"] {
    const stored = StoredDiscovery.safeParse(settings.get(discoveryKey(resolved.provider.id)));
    if (!resolved.baseUrl || !stored.success || stored.data.fingerprint !== credentialFingerprint(resolved.baseUrl, resolved.key)) {
      return { state: "none", ids: [], error: null, fetchedAt: null };
    }
    const d = stored.data;
    const fetchedAt = d.fetchedAt === null ? null : new Date(d.fetchedAt).toISOString();
    if (!d.error) return { state: "fresh", ids: d.ids, error: null, fetchedAt };
    return { state: d.fetchedAt === null ? "failed" : "stale", ids: d.ids, error: d.error, fetchedAt };
  }

  function view(provider: StoredProvider): CustomProviderView {
    const resolved = resolve(provider);
    const verified = verifications(resolved);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: { value: resolved.baseUrl, source: resolved.baseUrlSource, env: resolved.envUrl, error: resolved.envUrlError },
      key: { source: resolved.keySource, hint: resolved.key ? hintFor(resolved.key) : null },
      envNames: customProviderEnv(provider.id),
      models: provider.models.map((m) => ({ ...m, modelId: customModelId(provider.id, m.id), verification: verified[m.id]! })),
      discovery: discoveryView(resolved),
    };
  }

  /** Checks and de-duplicates configured models (the first of an id wins). */
  function normaliseModels(models: unknown[]): StoredModel[] {
    const seen = new Map<string, StoredModel>();
    for (const input of models) {
      const parsed = CustomModelInput.safeParse(input);
      if (!parsed.success) {
        const id = (input as { id?: unknown } | null)?.id;
        const issue = parsed.error.issues[0]!;
        const what = issue.path[0] === "contextLength" ? "The context length" : issue.path[0] === "maxOutputTokens" ? "The output limit" : undefined;
        throw new CustomProviderError(what ? `${what} for ${String(id).slice(0, 150)} must be a whole number of tokens.` : issue.message);
      }
      const m = parsed.data;
      if (!seen.has(m.id)) seen.set(m.id, { id: m.id, contextLength: m.contextLength ?? null, maxOutputTokens: m.maxOutputTokens ?? null });
    }
    if (seen.size > MAX_CUSTOM_MODELS) throw new CustomProviderError(`A provider can have at most ${MAX_CUSTOM_MODELS} models.`);
    return [...seen.values()];
  }

  function checkName(state: StoredSettings, name: string, except?: string) {
    if (state.providers.some((p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase())) {
      throw new CustomProviderError(`There's already a provider called ${name}.`);
    }
  }

  function checkedUrl(baseUrl: string | null | undefined): string | null | undefined {
    if (baseUrl === undefined || baseUrl === null) return baseUrl;
    const parsed = parseBaseUrl(baseUrl);
    if (!parsed.ok) throw new CustomProviderError(parsed.message);
    return parsed.url;
  }

  /** Forgets discovered lists and test results: they belonged to another URL or key. */
  function invalidate(id: string) {
    settings.delete(discoveryKey(id));
    settings.delete(verificationKey(id));
  }

  /** The configuration in force for a model, or why it can't run. */
  function runnable(id: string): { resolved: Resolved & { baseUrl: string }; model: StoredModel } {
    const parsed = parseCustomModelId(id);
    if (!parsed) throw new CustomProviderError("Unknown model. Choose another model in the picker under the message box.");
    const state = load();
    const provider = state.providers.find((p) => p.id === parsed.providerId);
    if (!provider) {
      const name = state.removed[parsed.providerId];
      throw new CustomProviderError(`${name ? `The provider ${name}` : "This model's provider"} was removed. Choose another model in the picker under the message box.`);
    }
    const model = provider.models.find((m) => m.id === parsed.modelId);
    if (!model) throw new CustomProviderError(`${parsed.modelId} isn't one of ${provider.name}'s models any more. Choose another model in the picker under the message box.`);
    const resolved = resolve(provider);
    if (!resolved.baseUrl) throw new CustomProviderError(`${provider.name} has no API base URL. Set one under Model providers.`);
    return { resolved: resolved as Resolved & { baseUrl: string }, model };
  }

  /**
   * Fetch for a provider's requests. Its key goes only to its own base URL, never through a redirect (which could
   * carry it elsewhere), and no other credential is ever added: the SDK sets only this provider's key.
   */
  const guardedFetch = (baseUrl: string): typeof fetch => async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== baseUrl && !url.startsWith(`${baseUrl}/`)) throw new CustomProviderError("Blocked a request outside the provider's base URL.");
    return fetchImpl(input, { ...init, redirect: "error" });
  };

  function buildModel(resolved: Resolved & { baseUrl: string }, model: StoredModel): LanguageModel {
    // Chat Completions explicitly (issue #69): nothing here infers Responses support or reasoning options from a
    // model's name, and no effort is ever sent.
    const provider = createOpenAICompatible({
      name: "custom",
      baseURL: resolved.baseUrl,
      ...(resolved.key ? { apiKey: resolved.key } : {}),
      fetch: guardedFetch(resolved.baseUrl),
      includeUsage: true,
    });
    const key = resolved.key;
    const clean = (error: unknown) => redactedError(error, key);
    // Every error leaves the model without the key, before the SDK logs it or a run stores it (runs.error).
    const chat = wrapLanguageModel({
      model: provider.chatModel(model.id),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate }) => {
          try {
            return await doGenerate();
          } catch (error) {
            throw clean(error);
          }
        },
        wrapStream: async ({ doStream }) => {
          let result: Awaited<ReturnType<typeof doStream>>;
          try {
            result = await doStream();
          } catch (error) {
            throw clean(error);
          }
          const stream = result.stream.pipeThrough(
            new TransformStream({ transform: (part, controller) => controller.enqueue(part.type === "error" ? { ...part, error: clean(part.error) } : part) }),
          );
          return { ...result, stream };
        },
      },
    });
    const maxOutputTokens = model.maxOutputTokens;
    if (!maxOutputTokens) return chat;
    // A limit the learner entered under Advanced caps each call; without one, the provider's own default applies.
    return wrapLanguageModel({
      model: chat,
      middleware: { specificationVersion: "v4", transformParams: async ({ params }) => ({ ...params, maxOutputTokens: Math.min(params.maxOutputTokens ?? maxOutputTokens, maxOutputTokens) }) },
    });
  }

  /** Classifies a failed request into a message the learner can act on. Never includes the key. */
  function explain(error: unknown, resolved: Resolved & { baseUrl: string }, modelId: string, how: { cancelled: boolean; timedOut: boolean }): TestResult & { ok: false } {
    if (how.cancelled) return { ok: false, reason: "cancelled", message: "The test was cancelled." };
    if (how.timedOut) return { ok: false, reason: "timeout", message: "The provider didn't finish answering within 60 seconds." };
    if (error instanceof CustomProviderError) return { ok: false, reason: "other", message: error.message };
    const host = new URL(resolved.baseUrl).host;
    const cause = (error as { cause?: unknown })?.cause;
    const text = `${error instanceof Error ? error.message : ""} ${cause instanceof Error ? cause.message : ""}`.toLowerCase();
    if (text.includes("redirect")) {
      return { ok: false, reason: "endpoint", message: "The provider redirected the request. Mivra doesn't follow redirects with your key: enter the final address as the base URL." };
    }
    if (APICallError.isInstance(error)) {
      const status = error.statusCode;
      if (status === undefined) return { ok: false, reason: "unreachable", message: `Couldn't reach ${host}. Check the URL and that the service is running.` };
      const detail = scrub(providerMessage(error.responseBody) ?? "", resolved.key);
      const said = detail ? ` The provider said: “${detail}”` : "";
      if (status === 401 || status === 403) return { ok: false, reason: "auth", message: `The provider rejected the API key (HTTP ${status}).${said}` };
      const lower = detail.toLowerCase();
      if ((status === 404 || status === 405) && !lower.includes("model")) {
        return { ok: false, reason: "endpoint", message: `Nothing answered at ${resolved.baseUrl}/chat/completions (HTTP ${status}). Check the base URL: it should be where the API's paths start, often ending in /v1.${said}` };
      }
      if (lower.includes("tool") || lower.includes("function")) {
        return { ok: false, reason: "tools", message: `The provider rejected tool calling for this model, which Mivra's learning tools need.${said}` };
      }
      if (lower.includes("model") && (status === 404 || status === 400 || status === 422)) {
        return { ok: false, reason: "model", message: `The provider doesn't accept the model “${modelId}”.${said}` };
      }
      if (lower.includes("stream")) return { ok: false, reason: "streaming", message: `The provider rejected a streamed request, which Mivra needs.${said}` };
      return { ok: false, reason: "other", message: `The provider answered HTTP ${status}.${said}` };
    }
    const name = error instanceof Error ? error.name : "";
    if (name === "TypeError" || text.includes("fetch failed") || text.includes("econnrefused") || text.includes("enotfound")) {
      return { ok: false, reason: "unreachable", message: `Couldn't reach ${host}. Check the URL and that the service is running.` };
    }
    if (/json|typevalidation|invalidresponse|parse/i.test(name)) {
      return { ok: false, reason: "streaming", message: "The provider's answer wasn't a Chat Completions stream Mivra could read." };
    }
    return { ok: false, reason: "other", message: "The test failed with an unexpected error." };
  }

  /** One bounded `GET <base>/models`. Throws a CustomProviderError the learner can act on. */
  async function discover(baseUrl: string, key: string | undefined): Promise<string[]> {
    let response: Response;
    try {
      response = await guardedFetch(baseUrl)(`${baseUrl}/models`, {
        headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
    } catch (error) {
      const text = `${(error as Error)?.message ?? ""} ${((error as { cause?: Error })?.cause)?.message ?? ""}`.toLowerCase();
      if ((error as Error)?.name === "TimeoutError") throw new CustomProviderError("The model list didn't arrive within 10 seconds. You can still enter model ids by hand.");
      if (text.includes("redirect")) throw new CustomProviderError("The model list redirected elsewhere. Mivra doesn't follow redirects with your key. You can still enter model ids by hand.");
      throw new CustomProviderError(`Couldn't reach ${new URL(baseUrl).host}. Check the URL and that the service is running. You can still enter model ids by hand.`);
    }
    if (!response.ok) {
      const body = await readCapped(response, 64 * 1024).catch(() => "");
      const detail = scrub(providerMessage(body) ?? "", key);
      const said = detail ? ` The provider said: “${detail}”` : "";
      if (response.status === 401 || response.status === 403) throw new CustomProviderError(`The provider rejected the API key when listing models (HTTP ${response.status}).${said}`);
      if (response.status === 404 || response.status === 405) {
        throw new CustomProviderError(`This provider has no model list at ${baseUrl}/models (HTTP ${response.status}). Enter model ids by hand; chat may still work.`);
      }
      throw new CustomProviderError(`The model list answered HTTP ${response.status}.${said} You can still enter model ids by hand.`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await readCapped(response, MAX_LIST_BYTES));
    } catch (error) {
      if (error instanceof CustomProviderError) throw error;
      throw new CustomProviderError("The model list isn't JSON. You can still enter model ids by hand.");
    }
    return parseModelList(body);
  }

  /** A streamed call that should make one tool call and then continue after its result. */
  async function probe(resolved: Resolved & { baseUrl: string }, model: StoredModel, signal?: AbortSignal): Promise<TestResult> {
    const number = 1000 + Math.floor(Math.random() * 9000);
    let called = false;
    let continued = false;
    let toolError = false;
    const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = streamText({
        model: buildModel(resolved, model),
        system: "You are checking that tool calling works. Follow the instructions exactly.",
        prompt: `Call the record_number tool once with the number ${number}. After it returns, reply with the single word: done.`,
        tools: {
          record_number: tool({
            description: "Records a number.",
            inputSchema: z.object({ number: z.number() }),
            execute: async () => {
              called = true;
              return { recorded: true };
            },
          }),
        },
        stopWhen: stepCountIs(2),
        maxRetries: 0,
        abortSignal: abort,
        // The error is classified below; without this the SDK would log it to the console.
        onError: () => {},
      });
      let step = 0;
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throw new DOMException("Aborted", "AbortError");
        if (part.type === "tool-error") toolError = true;
        if (part.type === "finish-step") step++;
        if (part.type === "text-delta" && step >= 1 && called && part.text.trim()) continued = true;
      }
    } catch (error) {
      return explain(error, resolved, model.id, { cancelled: Boolean(signal?.aborted), timedOut: timeout.aborted });
    }
    if (!called) {
      return {
        ok: false,
        reason: "tools",
        message: toolError
          ? "The model called the test tool with input Mivra couldn't use. Mivra's learning tools need reliable tool calling."
          : "The model answered without calling the test tool. Mivra's learning tools need streamed tool calling, so this model may not work well.",
      };
    }
    if (!continued) return { ok: false, reason: "tools", message: "The model called the tool but didn't continue after its result, which Mivra's lessons and checks rely on." };
    return { ok: true, message: "Streaming, tool calling and continuing after a tool result all work." };
  }

  /** Checks a key before it's saved, so a bad one changes nothing. */
  function checkedKey(key: string): string {
    const parsed = ApiKey.safeParse(key);
    if (!parsed.success) throw new CustomProviderError(parsed.error.issues[0]!.message);
    return parsed.data;
  }

  function checkedName(name: string): string {
    const parsed = ProviderName.safeParse(name);
    if (!parsed.success) throw new CustomProviderError(parsed.error.issues[0]!.message);
    return parsed.data;
  }

  return {
    list(): CustomProviderView[] {
      return load().providers.map(view);
    },

    /** Display names by provider key (`custom:<id>`), including removed providers, so old replies stay labelled. */
    names(): { id: string; name: string; removed: boolean }[] {
      const state = load();
      return [
        ...state.providers.map((p) => ({ id: customKeyName(p.id), name: p.name, removed: false })),
        ...Object.entries(state.removed).map(([id, name]) => ({ id: customKeyName(id), name, removed: true })),
      ];
    },

    create(input: { name: string; baseUrl?: string | null; key?: string; models?: unknown[] }): CustomProviderView {
      const state = load();
      if (state.providers.length >= MAX_CUSTOM_PROVIDERS) throw new CustomProviderError(`Mivra holds at most ${MAX_CUSTOM_PROVIDERS} custom providers.`);
      const name = checkedName(input.name);
      checkName(state, name);
      const baseUrl = checkedUrl(input.baseUrl) ?? null;
      const models = normaliseModels(input.models ?? []);
      // Ids are never reused, so a new provider can't take over a removed one's history.
      const taken = new Set([...state.providers.map((p) => p.id), ...Object.keys(state.removed)]);
      const stem = slug(name);
      let id = stem;
      for (let n = 2; taken.has(id); n++) id = `${stem.slice(0, 28)}-${n}`;
      const key = input.key === undefined ? undefined : checkedKey(input.key);
      if (key !== undefined) credentials.setCustomKey(id, key);
      // A key left over from a provider with this id can't exist (ids aren't reused), but clear stale lists anyway.
      invalidate(id);
      const provider: StoredProvider = { id, name, baseUrl, models };
      save({ ...state, providers: [...state.providers, provider] });
      return view(provider);
    },

    /**
     * Changes a provider. `baseUrl: null` goes back to the environment's URL; `key: null` removes the saved key.
     * A new URL or key invalidates its discovered list and test results. It applies from the next run: a run
     * already streaming keeps the model it started with.
     */
    update(id: string, input: { name?: string; baseUrl?: string | null; key?: string | null; models?: unknown[] }): CustomProviderView {
      const state = load();
      const index = state.providers.findIndex((p) => p.id === id);
      if (index < 0) throw new CustomProviderNotFound();
      const current = state.providers[index]!;
      const name = input.name === undefined ? current.name : checkedName(input.name);
      checkName(state, name, id);
      const baseUrl = input.baseUrl === undefined ? current.baseUrl : (checkedUrl(input.baseUrl) ?? null);
      const models = input.models === undefined ? current.models : normaliseModels(input.models);
      const key = typeof input.key === "string" ? checkedKey(input.key) : input.key;
      const before = resolve(current);
      if (key !== undefined && before.keySource === "env") {
        throw new CustomProviderError(`This key comes from ${customProviderEnv(id).key}. Change or unset it there.`);
      }
      if (key === null) credentials.removeCustomKey(id);
      else if (key !== undefined) credentials.setCustomKey(id, key);
      const next: StoredProvider = { ...current, name, baseUrl, models };
      const providers = [...state.providers];
      providers[index] = next;
      save({ ...state, providers });
      const after = resolve(next);
      if (before.baseUrl !== after.baseUrl || before.key !== after.key) invalidate(id);
      return view(next);
    },

    /** Removes a provider, its saved key, list and results. Its id stays taken; its name stays for old replies. */
    remove(id: string): boolean {
      const state = load();
      const provider = state.providers.find((p) => p.id === id);
      if (!provider) return false;
      credentials.removeCustomKey(id);
      invalidate(id);
      save({ providers: state.providers.filter((p) => p.id !== id), removed: { ...state.removed, [id]: provider.name } });
      return true;
    },

    /**
     * Asks `<base URL>/models` for the provider's models, with only its own key. A failure keeps the last good list,
     * marked stale, and never stops the learner entering ids by hand.
     */
    async refresh(id: string): Promise<CustomProviderView> {
      const provider = find(id);
      if (!provider) throw new CustomProviderNotFound();
      const resolved = resolve(provider);
      if (!resolved.baseUrl) throw new CustomProviderError("Set the API base URL first.");
      const fingerprint = credentialFingerprint(resolved.baseUrl, resolved.key);
      const previous = StoredDiscovery.safeParse(settings.get(discoveryKey(id)));
      const last = previous.success && previous.data.fingerprint === fingerprint ? previous.data : undefined;
      try {
        const ids = await discover(resolved.baseUrl, resolved.key);
        // The configuration may have changed while the list loaded; a list for an old URL or key is dropped.
        const now = find(id);
        if (now && credentialFingerprint(resolve(now).baseUrl ?? "", resolve(now).key) === fingerprint) {
          settings.set(discoveryKey(id), { fingerprint, ids, fetchedAt: clock(), error: null });
        }
      } catch (error) {
        const message = error instanceof CustomProviderError ? error.message : "Couldn't load the model list.";
        settings.set(discoveryKey(id), { fingerprint, ids: last?.ids ?? [], fetchedAt: last?.fetchedAt ?? null, error: message });
      }
      return view(find(id) ?? provider);
    },

    /**
     * Checks that a configured model does what Mivra needs: a streamed Chat Completions call that makes a tool call,
     * then continues after the tool's result. It spends a few tokens. The result is kept for this URL and key only.
     */
    async test(id: string, modelId: string, signal?: AbortSignal): Promise<TestResult> {
      const provider = find(id);
      if (!provider) throw new CustomProviderNotFound();
      if (!provider.models.some((m) => m.id === modelId)) throw new CustomProviderError(`Add ${modelId} to ${provider.name}'s models first.`);
      const { resolved, model } = runnable(customModelId(id, modelId));
      const fingerprint = credentialFingerprint(resolved.baseUrl, resolved.key);
      const result = await probe(resolved, model, signal);
      // A cancelled test says nothing about the model; the earlier result stands.
      if (!result.ok && result.reason === "cancelled") return result;
      const now = find(id);
      if (now && credentialFingerprint(resolve(now).baseUrl ?? "", resolve(now).key) === fingerprint) {
        const stored = StoredVerification.safeParse(settings.get(verificationKey(id)));
        settings.set(verificationKey(id), {
          ...(stored.success ? stored.data : {}),
          [modelId]: { fingerprint, status: result.ok ? "verified" : "failed", message: result.ok ? null : result.message, at: clock() },
        });
      }
      return result;
    },

    /** Picker entries for every model of a provider with a base URL. Unknown price and reasoning stay unknown. */
    catalog(): (CatalogModel & { verification: Verification["status"] })[] {
      return load().providers.flatMap((provider) => {
        const resolved = resolve(provider);
        if (!resolved.baseUrl) return [];
        const verified = verifications(resolved);
        return provider.models.map((m) => ({
          id: customModelId(provider.id, m.id),
          name: m.id,
          contextLength: m.contextLength,
          price: null,
          reasoning: null,
          verification: verified[m.id]!.status,
        }));
      });
    },

    /** Why the current selection can't run, when it's a custom model that no longer can; otherwise null. */
    unavailable(modelId: string): string | null {
      if (!modelId.startsWith(CUSTOM_PREFIX)) return null;
      try {
        runnable(modelId);
        return null;
      } catch (error) {
        return error instanceof CustomProviderError ? error.message : "This model can't be used any more. Choose another model.";
      }
    },

    /** The endpoint a run on this model would call, recorded with the run (see `endpointFingerprint`). */
    endpointFor(modelId: string): string | undefined {
      try {
        return endpointFingerprint(runnable(modelId).resolved.baseUrl);
      } catch {
        return undefined;
      }
    },

    /** The model for a run, built from the configuration now. A run keeps it to the end, whatever changes meanwhile. */
    languageModel(selection: ModelSelection): LanguageModel {
      const { resolved, model } = runnable(selection.model);
      return buildModel(resolved, model);
    },
  };
}

export class CustomProviderNotFound extends Error {
  constructor() {
    super("No such provider");
  }
}

export type CustomProviders = ReturnType<typeof createCustomProviders>;
