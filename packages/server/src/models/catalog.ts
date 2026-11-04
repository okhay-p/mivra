import { z } from "zod";
import { reasoningEfforts, type ReasoningEffort } from "../model.js";

/** A model the picker can offer (ADR-012). Ids carry the provider prefix, like a selection. */
export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** US dollars per million tokens, when the provider lists a price. */
  price: { input: number; output: number } | null;
  /** Null when the model can't be asked to reason. `efforts` may be empty: then only its default applies. */
  reasoning: { efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort | null } | null;
}

export type CatalogState = "fresh" | "stale" | "unavailable";

export interface ModelCatalog {
  /** The models, or an empty list when none could ever be loaded. `stale` means the last refresh failed. */
  list(): Promise<{ models: CatalogModel[]; state: CatalogState }>;
}

/** A fixed catalog, for tests and for setups without a network. */
export const staticCatalog = (models: CatalogModel[]): ModelCatalog => ({ list: async () => ({ models, state: "fresh" }) });

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const TTL_MS = 60 * 60 * 1000;
/** After a failed refresh, how long to serve the old copy before trying again. */
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 10_000;
/** The live list is under 1 MB; anything far bigger isn't the list. */
const MAX_BYTES = 16 * 1024 * 1024;

const isEffort = (value: unknown): value is ReasoningEffort => reasoningEfforts.includes(value as ReasoningEffort);

const OpenRouterModel = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  context_length: z.number().int().positive().nullish(),
  pricing: z.object({ prompt: z.string().max(40), completion: z.string().max(40) }).partial().nullish(),
  supported_parameters: z.array(z.string()).max(100).nullish(),
  reasoning: z
    .object({ supported_efforts: z.array(z.string()).max(20).nullish(), default_effort: z.string().nullish() })
    .nullish(),
});

const perMillion = (perToken: string | undefined) => {
  const value = Number(perToken);
  // OpenRouter marks variable-price routers such as openrouter/auto with -1.
  return perToken !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6 * 1e4) / 1e4 : undefined;
};

/**
 * OpenRouter's list, kept to models that can call tools (Mivra's learning tools need them). Batch variants
 * are left out: they can't stream. An entry that doesn't parse is skipped rather than failing the list.
 */
export function parseOpenRouterModels(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("OpenRouter's model list has no data array");
  const seen = new Set<string>();
  return data.flatMap((entry): CatalogModel[] => {
    const parsed = OpenRouterModel.safeParse(entry);
    if (!parsed.success) return [];
    const m = parsed.data;
    const params = m.supported_parameters ?? [];
    if (!params.includes("tools") || m.id.endsWith(":batch") || seen.has(m.id)) return [];
    seen.add(m.id);
    const input = perMillion(m.pricing?.prompt);
    const output = perMillion(m.pricing?.completion);
    const efforts = (m.reasoning?.supported_efforts ?? []).filter(isEffort);
    const defaultEffort = isEffort(m.reasoning?.default_effort) ? m.reasoning.default_effort : null;
    return [{
      id: `openrouter:${m.id}`,
      name: m.name?.trim() || m.id,
      contextLength: m.context_length ?? null,
      price: input !== undefined && output !== undefined ? { input, output } : null,
      reasoning: params.includes("reasoning") ? { efforts: reasoningEfforts.filter((e) => efforts.includes(e)), defaultEffort } : null,
    }];
  });
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("The model list is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface CatalogSourceOptions {
  fetch?: typeof fetch;
  clock?: () => number;
  /** Keeps the last good list across restarts, so the picker works offline. */
  persist?: { load(): unknown; save(models: unknown[]): void };
}

interface CachedList<T> {
  list(): Promise<{ items: T[] | undefined; state: CatalogState }>;
}

/** Loads a list, caches it for an hour, and falls back to the last good copy (kept across restarts by `persist`). */
function cachedList<T>(
  load: (fetchImpl: typeof fetch) => Promise<T[]>,
  isItem: (value: unknown) => boolean,
  { fetch: fetchImpl = fetch, clock = Date.now, persist }: CatalogSourceOptions,
): CachedList<T> {
  const saved = z.array(z.custom<T>(isItem)).safeParse(persist?.load());
  let items: T[] | undefined = saved.success ? saved.data : undefined;
  let loadedAt = -Infinity;
  let failedAt = -Infinity;
  let inFlight: Promise<void> | undefined;

  async function refresh() {
    try {
      const fresh = await load(fetchImpl);
      items = fresh;
      loadedAt = clock();
      persist?.save(fresh);
    } catch {
      failedAt = clock();
    }
  }

  return {
    async list() {
      const now = clock();
      if (now - loadedAt >= TTL_MS && now - failedAt >= RETRY_MS) {
        inFlight ??= refresh().finally(() => (inFlight = undefined));
        await inFlight;
      }
      if (!items) return { items: undefined, state: "unavailable" };
      return { items, state: clock() - loadedAt < TTL_MS ? "fresh" : "stale" };
    },
  };
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, what: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${what} returned ${response.status}`);
  return JSON.parse(await readCapped(response));
}

const isCatalogModel = (value: unknown) => typeof (value as CatalogModel)?.id === "string";

function openRouterList(options: CatalogSourceOptions): CachedList<CatalogModel> {
  return cachedList(async (f) => parseOpenRouterModels(await getJson(f, OPENROUTER_MODELS_URL, {}, "OpenRouter's model list")), isCatalogModel, options);
}

/** OpenRouter's public model list (no key needed), cached for an hour, falling back to the last good copy. */
export function createOpenRouterCatalog(options: CatalogSourceOptions = {}): ModelCatalog {
  const source = openRouterList(options);
  return {
    async list() {
      const { items, state } = await source.list();
      return { models: items ?? [], state };
    },
  };
}

/** Providers Mivra can call without OpenRouter (ADR-012 build step 2). */
export type DirectProvider = "anthropic" | "openai";

/** A model as a provider's own list names it. Those lists say little else, so the rest comes from OpenRouter's. */
export interface DirectModel {
  id: string;
}

const DirectList = z.object({
  data: z.array(z.unknown()).max(5000),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});
const DirectEntry = z.object({ id: z.string().min(1).max(200) });

/** The ids in a provider's model list; entries that don't parse are skipped. */
export function parseDirectModels(body: unknown): { models: DirectModel[]; next?: string } {
  const parsed = DirectList.parse(body);
  const models = parsed.data.flatMap((entry) => {
    const m = DirectEntry.safeParse(entry);
    return m.success ? [{ id: m.data.id }] : [];
  });
  return { models, next: parsed.has_more && parsed.last_id ? parsed.last_id : undefined };
}

/** Anthropic's list is paged; a few pages is far more than it has. */
const MAX_PAGES = 5;

const DIRECT_LISTS: Record<DirectProvider, (key: string, baseUrl: string | undefined) => { url: (after?: string) => string; headers: Record<string, string> }> = {
  anthropic: (key, baseUrl = "https://api.anthropic.com/v1") => ({
    url: (after) => `${baseUrl.replace(/\/$/, "")}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  openai: (key, baseUrl = "https://api.openai.com/v1") => ({
    url: () => `${baseUrl.replace(/\/$/, "")}/models`,
    headers: { authorization: `Bearer ${key}` },
  }),
};

function directList(provider: DirectProvider, key: string, baseUrl: string | undefined, options: CatalogSourceOptions): CachedList<DirectModel> {
  const { url, headers } = DIRECT_LISTS[provider](key, baseUrl);
  return cachedList(
    async (f) => {
      const models: DirectModel[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = parseDirectModels(await getJson(f, url(after), headers, `${provider}'s model list`));
        models.push(...result.models);
        if (!result.next) break;
        after = result.next;
      }
      return models;
    },
    (value) => typeof (value as DirectModel)?.id === "string",
    options,
  );
}

/** Snapshots match their alias (Anthropic dates them "-20261001", OpenAI "-2026-10-01"), and dots become dashes. */
const matchKey = (id: string) => id.toLowerCase().replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "").replace(/\./g, "-");

/**
 * A provider's own models, described by their OpenRouter counterpart (`anthropic/…`, `openai/…`). A model
 * OpenRouter doesn't list as able to call tools is left out: Mivra's learning tools need them, and the
 * provider's list can't say. Dated snapshots match their alias and are listed under their own id.
 */
export function matchDirectModels(provider: DirectProvider, direct: DirectModel[], openrouter: CatalogModel[]): CatalogModel[] {
  const prefix = `openrouter:${provider}/`;
  const counterparts = new Map<string, CatalogModel>();
  for (const m of openrouter) {
    if (m.id.startsWith(prefix)) counterparts.set(matchKey(m.id.slice(prefix.length)), m);
  }
  const seen = new Set<string>();
  return direct.flatMap((m): CatalogModel[] => {
    const counterpart = counterparts.get(matchKey(m.id));
    if (!counterpart || seen.has(m.id)) return [];
    seen.add(m.id);
    return [{ ...counterpart, id: `${provider}:${m.id}` }];
  });
}

export interface ProviderCatalogOptions extends CatalogSourceOptions {
  /** API keys from the environment. A provider is listed only when its key is set (ADR-012). */
  keys: { openrouter?: string; anthropic?: string; openai?: string };
  /** Base URLs for the direct providers, as their SDKs read them (ANTHROPIC_BASE_URL, OPENAI_BASE_URL). */
  baseUrls?: Partial<Record<DirectProvider, string>>;
  /** One store per source; each keeps its last good list. */
  persistFor?: (source: "openrouter" | DirectProvider) => CatalogSourceOptions["persist"];
}

/**
 * The models of every provider whose key is set: OpenRouter's list, then Anthropic's and OpenAI's own models.
 * OpenRouter's public list is loaded even without its key, since it describes the direct providers' models.
 */
export function createProviderCatalog({ keys, baseUrls = {}, persistFor, ...options }: ProviderCatalogOptions): ModelCatalog {
  const openrouter = openRouterList({ ...options, persist: persistFor?.("openrouter") });
  const direct = (["anthropic", "openai"] as const).flatMap((provider) => {
    const key = keys[provider];
    return key ? [{ provider, source: directList(provider, key, baseUrls[provider], { ...options, persist: persistFor?.(provider) }) }] : [];
  });

  return {
    async list() {
      const [or, ...lists] = await Promise.all([openrouter.list(), ...direct.map((d) => d.source.list())]);
      const described = or.items ?? [];
      const models = [
        ...(keys.openrouter ? described : []),
        ...direct.flatMap((d, i) => matchDirectModels(d.provider, lists[i]!.items ?? [], described)),
      ];
      // Direct models are described by OpenRouter's list, so they depend on it even without its key.
      const states = [or.state, ...lists.map((l) => l.state)];
      const state: CatalogState = states.every((s) => s === "fresh") ? "fresh" : models.length > 0 ? "stale" : "unavailable";
      return { models, state };
    },
  };
}
