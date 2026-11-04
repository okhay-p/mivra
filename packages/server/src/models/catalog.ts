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
      throw new Error("OpenRouter's model list is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface OpenRouterCatalogOptions {
  fetch?: typeof fetch;
  clock?: () => number;
  /** Keeps the last good list across restarts, so the picker works offline. */
  persist?: { load(): unknown; save(models: CatalogModel[]): void };
}

/** OpenRouter's public model list (no key needed), cached for an hour, falling back to the last good copy. */
export function createOpenRouterCatalog({ fetch: fetchImpl = fetch, clock = Date.now, persist }: OpenRouterCatalogOptions = {}): ModelCatalog {
  const saved = z.array(z.custom<CatalogModel>((value) => typeof (value as CatalogModel)?.id === "string")).safeParse(persist?.load());
  let models: CatalogModel[] | undefined = saved.success ? saved.data : undefined;
  let loadedAt = -Infinity;
  let failedAt = -Infinity;
  let inFlight: Promise<void> | undefined;

  async function refresh() {
    try {
      const response = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`OpenRouter's model list returned ${response.status}`);
      const fresh = parseOpenRouterModels(JSON.parse(await readCapped(response)));
      models = fresh;
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
      if (!models) return { models: [], state: "unavailable" };
      return { models, state: clock() - loadedAt < TTL_MS ? "fresh" : "stale" };
    },
  };
}
