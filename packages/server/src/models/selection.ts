import { z } from "zod";
import type { ProviderKeys } from "../credentials.js";
import { reasoningEfforts, type ModelSelection } from "../model.js";
import type { SettingsStore } from "../store/settings-store.js";
import type { CatalogModel, CatalogState, ModelCatalog } from "./catalog.js";

/**
 * Tool-capable models offered before the learner has picked enough of their own (ADR-012). Only models the
 * catalog lists show, so each provider's appear only when its key is set. Direct models come first: when both
 * a direct model and its OpenRouter counterpart are listed, only the direct one is suggested.
 */
export const SUGGESTED_MODELS = [
  "chatgpt:gpt-6-luna",
  "chatgpt:gpt-6.1-sol",
  "anthropic:claude-sonnet-5-5",
  "anthropic:claude-opus-5-5",
  "openai:gpt-6-luna",
  "openai:gpt-6.1-sol",
  "openrouter:openai/gpt-6-luna",
  "openrouter:anthropic/claude-sonnet-5.5",
  "openrouter:anthropic/claude-opus-5.5",
  "openrouter:anthropic/claude-haiku-5.5",
  "openrouter:openai/gpt-6.1-sol",
  "openrouter:openai/gpt-6.1-terra",
  "openrouter:google/gemini-3.8-flash",
  "openrouter:deepseek/deepseek-v4.1-flash",
  "openrouter:moonshotai/kimi-k3.1-pro",
];

/** The model a new install uses until the learner picks one (ADR-012). Needs only OPENROUTER_API_KEY. */
export const DEFAULT_SELECTION: ModelSelection = { model: "openrouter:openai/gpt-6-luna", effort: "high" };

/** The default when the learner has signed in with ChatGPT (ADR-015). */
export const CHATGPT_DEFAULT: ModelSelection = { model: "chatgpt:gpt-6-luna", effort: "high" };

/**
 * The built-in default for the providers set up: ChatGPT when the learner signed in (an explicit choice that
 * costs nothing extra), else OpenRouter's if its key is set, otherwise a direct provider's.
 */
export function defaultSelectionFor(keys: ProviderKeys, chatgpt = false): ModelSelection {
  if (chatgpt) return CHATGPT_DEFAULT;
  if (keys.openrouter) return DEFAULT_SELECTION;
  if (keys.openai) return { model: "openai:gpt-6-luna", effort: "high" };
  if (keys.anthropic) return { model: "anthropic:claude-sonnet-5-5", effort: "high" };
  return DEFAULT_SELECTION;
}

const MAX_RECENT = 5;
export const MAX_PINNED = 20;
/** Once recent and pinned hold this many models, suggestions stop showing. */
const ENOUGH_OWN = 5;

const KEYS = { current: "model.current", recent: "model.recent", pinned: "model.pinned" } as const;

export const ModelId = z.string().min(1).max(200).regex(/^[a-z][a-z0-9-]*:\S+$/, "Use <provider>:<model-id>");
export const SelectionInput = z.object({ model: ModelId, effort: z.enum(reasoningEfforts).nullable() });
const Ids = z.array(ModelId);

export interface PickerView {
  current: ModelSelection;
  recent: string[];
  pinned: string[];
  suggested: string[];
  models: CatalogModel[];
  catalog: CatalogState;
}

export type SelectResult =
  | { ok: true; selection: ModelSelection }
  | { ok: false; kind: "invalid" | "unavailable"; message: string };

export interface ModelSettingsDeps {
  settings: SettingsStore;
  catalog: ModelCatalog;
  /** Used until the learner picks a model. Defaults to DEFAULT_SELECTION; a function follows the keys set now. */
  defaults?: ModelSelection | (() => ModelSelection);
  suggested?: string[];
}

/** The app-wide model selection, with the learner's recent and pinned models (ADR-012). */
export function createModelSettings({ settings, catalog, defaults: defaultsOption = DEFAULT_SELECTION, suggested = SUGGESTED_MODELS }: ModelSettingsDeps) {
  const defaults = () => (typeof defaultsOption === "function" ? defaultsOption() : defaultsOption);
  const read = <T>(key: string, schema: z.ZodType<T>, fallback: T): T => {
    const parsed = schema.safeParse(settings.get(key));
    return parsed.success ? parsed.data : fallback;
  };
  const current = (): ModelSelection => read(KEYS.current, SelectionInput, defaults());
  const recent = () => read(KEYS.recent, Ids, []);
  const pinned = () => read(KEYS.pinned, Ids, []);

  /** The catalog, plus the default when the catalog doesn't list it (offline, or a test's scripted model). */
  async function models() {
    const { models, state } = await catalog.list();
    const fallback = defaults();
    const all = models.some((m) => m.id === fallback.model)
      ? models
      : [{ id: fallback.model, name: fallback.model, contextLength: null, price: null, reasoning: null }, ...models];
    return { models: all, state };
  }

  /** Suggested models the catalog lists and the learner hasn't used, one per model name (direct before OpenRouter). */
  function suggestions(all: CatalogModel[], ownIds: Set<string>) {
    const byId = new Map(all.map((m) => [m.id, m]));
    const names = new Set([...ownIds].map((id) => byId.get(id)?.name));
    return suggested.filter((id) => {
      const name = byId.get(id)?.name;
      if (!name || ownIds.has(id) || names.has(name)) return false;
      names.add(name);
      return true;
    });
  }

  return {
    current,
    /** The selection for a run starting now. Counts as using the model, so it moves to the front of recent. */
    forRun(): ModelSelection {
      const selection = current();
      settings.set(KEYS.recent, [selection.model, ...recent().filter((id) => id !== selection.model)].slice(0, MAX_RECENT));
      return selection;
    },
    async picker(): Promise<PickerView> {
      const { models: all, state } = await models();
      const known = new Set(all.map((m) => m.id));
      const own = { recent: recent().filter((id) => known.has(id)), pinned: pinned().filter((id) => known.has(id)) };
      const ownIds = new Set([...own.recent, ...own.pinned]);
      return {
        current: current(),
        ...own,
        suggested: ownIds.size >= ENOUGH_OWN ? [] : suggestions(all, ownIds),
        models: all,
        catalog: state,
      };
    },
    async select(input: z.infer<typeof SelectionInput>): Promise<SelectResult> {
      const { models: all, state } = await models();
      const model = all.find((m) => m.id === input.model);
      if (!model) {
        return state === "unavailable"
          ? { ok: false, kind: "unavailable", message: "The model list couldn't be loaded, so the model can't be checked. Try again later." }
          : { ok: false, kind: "invalid", message: "That model isn't in the list of models that can use Mivra's tools" };
      }
      if (input.effort && !model.reasoning?.efforts.includes(input.effort)) {
        return { ok: false, kind: "invalid", message: `${model.name} doesn't support the "${input.effort}" effort` };
      }
      const selection = { model: model.id, effort: input.effort };
      settings.set(KEYS.current, selection);
      return { ok: true, selection };
    },
    setPinned(ids: string[]): string[] {
      const unique = [...new Set(ids)].slice(0, MAX_PINNED);
      settings.set(KEYS.pinned, unique);
      return unique;
    },
  };
}

export type ModelSettings = ReturnType<typeof createModelSettings>;
