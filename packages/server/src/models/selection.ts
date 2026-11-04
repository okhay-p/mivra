import { z } from "zod";
import { reasoningEfforts, type ModelSelection } from "../model.js";
import type { SettingsStore } from "../store/settings-store.js";
import type { CatalogModel, CatalogState, ModelCatalog } from "./catalog.js";

/** Tool-capable OpenRouter models offered before the learner has picked enough of their own (ADR-012). */
export const SUGGESTED_MODELS = [
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
export const DEFAULT_SELECTION: ModelSelection = { model: "openrouter:anthropic/claude-sonnet-5.5", effort: null };

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
  /** Used until the learner picks a model. Defaults to DEFAULT_SELECTION; tests pass their own. */
  defaults?: ModelSelection;
  suggested?: string[];
}

/** The app-wide model selection, with the learner's recent and pinned models (ADR-012). */
export function createModelSettings({ settings, catalog, defaults = DEFAULT_SELECTION, suggested = SUGGESTED_MODELS }: ModelSettingsDeps) {
  const read = <T>(key: string, schema: z.ZodType<T>, fallback: T): T => {
    const parsed = schema.safeParse(settings.get(key));
    return parsed.success ? parsed.data : fallback;
  };
  const current = (): ModelSelection => read(KEYS.current, SelectionInput, defaults);
  const recent = () => read(KEYS.recent, Ids, []);
  const pinned = () => read(KEYS.pinned, Ids, []);

  /** The catalog, plus the default when the catalog doesn't list it (offline, or a test's scripted model). */
  async function models() {
    const { models, state } = await catalog.list();
    const all = models.some((m) => m.id === defaults.model)
      ? models
      : [{ id: defaults.model, name: defaults.model, contextLength: null, price: null, reasoning: null }, ...models];
    return { models: all, state };
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
        suggested: ownIds.size >= ENOUGH_OWN ? [] : suggested.filter((id) => known.has(id) && !ownIds.has(id)),
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
