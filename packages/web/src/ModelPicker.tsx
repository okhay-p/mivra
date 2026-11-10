import { Check, ChevronsUpDown, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PROVIDERS_CHANGED,
  getModelPicker,
  selectModel,
  setPinnedModels,
  type CatalogModel,
  type ModelPickerView,
  type ModelSelection,
  type ReasoningEffort,
} from "./api.js";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { UsingChatGptPlan } from "./ChatGpt.js";

/** Most search matches listed at once; typing more narrows them. */
const MAX_MATCHES = 50;

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Custom providers' names by their model ids' prefix, `custom:<id>` (issue #69). */
export type ProviderNames = ModelPickerView["providers"];

const CUSTOM = "custom:";

/** "custom:deepseek/deepseek-flash" → "custom:deepseek"; undefined for a built-in provider's model. */
const customProviderKey = (id: string) => (id.startsWith(CUSTOM) && id.indexOf("/") > CUSTOM.length ? id.slice(0, id.indexOf("/")) : undefined);

/** A model's id as its provider names it: without the provider prefix (and a custom provider's id). */
export const providerModelId = (id: string) => (customProviderKey(id) ? id.slice(id.indexOf("/") + 1) : id.slice(id.indexOf(":") + 1));

/** "Anthropic: Claude Sonnet 5.5" → "Claude Sonnet 5.5"; an unknown id shows without its provider prefix. */
export function shortModelName(id: string, models: CatalogModel[] = []): string {
  if (customProviderKey(id)) return providerModelId(id);
  const name = models.find((m) => m.id === id)?.name;
  if (name && name !== id) return name.replace(/^[^:]{1,40}:\s+/, "");
  return id.replace(/^[a-z][a-z0-9-]*:/, "");
}

const PROVIDERS: Record<string, string> = { openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI", chatgpt: "ChatGPT" };

/** "anthropic:claude-sonnet-5-5" → "Anthropic"; a custom provider's model → the name the learner gave it. */
export function providerLabel(id: string, names: ProviderNames = []): string {
  const custom = customProviderKey(id);
  if (custom) return names.find((p) => p.id === custom)?.name ?? "Removed provider";
  const prefix = id.slice(0, Math.max(0, id.indexOf(":")));
  return PROVIDERS[prefix] ?? prefix;
}

/** The short name, plus the provider when it isn't OpenRouter, since a model can be reached both ways. */
export function modelLabel(id: string, models: CatalogModel[] = [], names: ProviderNames = []): string {
  const name = shortModelName(id, models);
  if (customProviderKey(id)) return `${name} (${providerLabel(id, names)})`;
  return id.startsWith("openrouter:") || !(id.split(":")[0]! in PROVIDERS) ? name : `${name} (${providerLabel(id)})`;
}

const VERIFICATION: Record<NonNullable<CatalogModel["verification"]>, string> = { unverified: "not tested", verified: "tested", failed: "test failed" };

function priceText(price: CatalogModel["price"]) {
  if (!price) return undefined;
  if (price.input === 0 && price.output === 0) return "free";
  const amount = (n: number) => `$${n < 1 ? n.toFixed(2) : Number(n.toFixed(2))}`;
  return `${amount(price.input)} in · ${amount(price.output)} out per 1M tokens`;
}

/** Every word of the query appears in the model's name or id. */
export function searchModels(models: CatalogModel[], query: string): CatalogModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => {
    const haystack = `${m.name} ${m.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The app-wide model selection (ADR-012): loads the picker, and saves changes to the server. */
export function useModelPicker() {
  const [view, setView] = useState<ModelPickerView>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const result = await getModelPicker();
    if (result.ok) setView(result.value);
    else setError(result.error);
  }, []);
  useEffect(() => {
    void refresh();
    // A key saved or removed in settings changes which models are listed, and maybe the default.
    const reload = () => void refresh();
    window.addEventListener(PROVIDERS_CHANGED, reload);
    return () => window.removeEventListener(PROVIDERS_CHANGED, reload);
  }, [refresh]);

  const choose = useCallback(
    async (selection: ModelSelection) => {
      setError(undefined);
      const result = await selectModel(selection);
      if (!result.ok) return setError(result.error);
      // The server accepted it, so it's one that can run.
      setView((prev) => (prev ? { ...prev, current: result.value, unavailable: null } : prev));
    },
    [],
  );

  const togglePin = useCallback(async (id: string) => {
    if (!view) return;
    setError(undefined);
    const next = view.pinned.includes(id) ? view.pinned.filter((p) => p !== id) : [...view.pinned, id];
    const result = await setPinnedModels(next);
    if (!result.ok) return setError(result.error);
    setView((prev) => (prev ? { ...prev, pinned: result.value } : prev));
  }, [view]);

  return { view, error, refresh, choose, togglePin };
}

export type ModelPickerState = ReturnType<typeof useModelPicker>;

function ModelRow({ model, selected, names }: { model: CatalogModel; selected: boolean; names: ProviderNames }) {
  // ChatGPT models are paid for by the learner's plan, not per token (ADR-015). A custom provider's price is unknown.
  const price = model.id.startsWith("chatgpt:") ? "your ChatGPT plan" : model.verification ? VERIFICATION[model.verification] : priceText(model.price);
  return (
    <>
      <Check className={cn("mt-0.5 self-start", selected ? "opacity-100" : "opacity-0")} aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{model.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {providerLabel(model.id, names)} · {providerModelId(model.id)}
          {price && ` · ${price}`}
        </span>
      </span>
    </>
  );
}

/** Model and effort controls for the composer. Changes apply from the next reply on. */
export function ModelPicker({ state, disabled }: { state: ModelPickerState; disabled?: boolean }) {
  const { view, error, refresh, choose, togglePin } = state;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const byId = useMemo(() => new Map(view?.models.map((m) => [m.id, m])), [view]);
  const sections = useMemo(() => {
    if (!view) return [];
    const lookup = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []);
    if (query.trim()) {
      const matches = searchModels(view.models, query);
      const shown = matches.slice(0, MAX_MATCHES);
      const note = matches.length > MAX_MATCHES ? `First ${MAX_MATCHES} of ${matches.length} matches` : undefined;
      // Grouped by provider once there's more than one; the catalog lists each provider's models together.
      const providers = [...new Set(shown.map((m) => providerLabel(m.id, view.providers)))];
      if (providers.length < 2) return [{ heading: note, models: shown }];
      return providers.map((provider, i) => ({
        heading: i === 0 && note ? `${note} · ${provider}` : provider,
        models: shown.filter((m) => providerLabel(m.id, view.providers) === provider),
      }));
    }
    const pinned = new Set(view.pinned);
    const used = new Set([...view.pinned, ...view.recent]);
    // The learner's ChatGPT plan offers a short list, so all of it shows without searching (ADR-015).
    const plan = view.models.filter((m) => m.id.startsWith("chatgpt:"));
    // So do the models the learner configured on their own providers (issue #69), under each provider's name.
    const custom = view.providers
      .filter((p) => !p.removed)
      .map((p) => ({ heading: p.name, models: view.models.filter((m) => m.id.startsWith(`${p.id}/`) && !used.has(m.id)) }));
    const own = [
      { heading: "Pinned", models: lookup(view.pinned) },
      { heading: "Recent", models: lookup(view.recent.filter((id) => !pinned.has(id))) },
      { heading: "ChatGPT plan", models: plan.filter((m) => !used.has(m.id)) },
      ...custom,
      { heading: "Suggested", models: lookup(view.suggested.filter((id) => !id.startsWith("chatgpt:"))) },
    ];
    // The current model is always one keystroke away, even before it's been used.
    const listed = new Set(own.flatMap((s) => s.models.map((m) => m.id)));
    const current = byId.get(view.current.model);
    return [...(current && !listed.has(current.id) ? [{ heading: "Current", models: [current] }] : []), ...own].filter((s) => s.models.length > 0);
  }, [view, query, byId]);

  if (!view) {
    return error ? <span className="text-destructive text-xs">{error}</span> : null;
  }
  const current = byId.get(view.current.model);
  const currentName = modelLabel(view.current.model, view.models, view.providers);
  const efforts = current?.reasoning?.efforts ?? [];
  const defaultEffort = current?.reasoning?.defaultEffort;
  const pinned = view.pinned.includes(view.current.model);

  const pick = (model: CatalogModel) => {
    setOpen(false);
    setQuery("");
    // Keep the effort when the new model supports it; otherwise use the model's default.
    const effort = view.current.effort && model.reasoning?.efforts.includes(view.current.effort) ? view.current.effort : null;
    if (model.id !== view.current.model || effort !== view.current.effort) void choose({ model: model.id, effort });
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) void refresh();
          else setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground max-w-64 min-w-0"
            aria-label={`Model: ${currentName}. Change model`}
            disabled={disabled}
          >
            <span className="truncate">{currentName}</span>
            <ChevronsUpDown aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(28rem,calc(100vw-2rem))] p-0" align="start">
          <Command shouldFilter={false} label="Choose a model">
            <CommandInput placeholder="Search models…" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-80" label="Models">
              <CommandEmpty>{view.catalog === "unavailable" ? "The model list couldn't be loaded." : "No models match."}</CommandEmpty>
              {sections.map((section, i) => (
                <CommandGroup key={section.heading ?? i} heading={section.heading}>
                  {section.models.map((model) => (
                    <CommandItem key={model.id} value={model.id} onSelect={() => pick(model)} className="items-start">
                      <ModelRow model={model} selected={model.id === view.current.model} names={view.providers} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
            {view.catalog !== "fresh" && (
              <p className="text-muted-foreground border-t px-3 py-2 text-xs">
                {view.catalog === "stale"
                  ? "Couldn't refresh every provider's model list, so some of this is a saved copy."
                  : "Couldn't load the model list. Search covers only the default model."}
              </p>
            )}
          </Command>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label={pinned ? `Unpin ${currentName}` : `Pin ${currentName}`}
        aria-pressed={pinned}
        title={pinned ? "Unpin this model" : "Pin this model to the top of the list"}
        disabled={disabled}
        onClick={() => void togglePin(view.current.model)}
      >
        <Star className={cn(pinned && "fill-current")} aria-hidden />
      </Button>
      {efforts.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={disabled}
              aria-label={`Reasoning effort: ${view.current.effort ? EFFORT_LABELS[view.current.effort] : "the model's default"}. Change effort`}>
              {view.current.effort ? EFFORT_LABELS[view.current.effort] : "Default effort"}
              <ChevronsUpDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={view.current.effort ?? "default"}
              onValueChange={(value) => void choose({ model: view.current.model, effort: value === "default" ? null : (value as ReasoningEffort) })}
            >
              <DropdownMenuRadioItem value="default">
                Default{defaultEffort ? ` (${EFFORT_LABELS[defaultEffort]})` : ""}
              </DropdownMenuRadioItem>
              {efforts.map((effort) => (
                <DropdownMenuRadioItem key={effort} value={effort}>{EFFORT_LABELS[effort]}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* OpenAI's guidelines: say when replies use the learner's plan, with a way to manage it (ADR-015). */}
      {view.current.model.startsWith("chatgpt:") && <UsingChatGptPlan />}
      {/* A removed custom provider isn't silently replaced: the learner chooses the next model. */}
      {view.unavailable && !error && <span role="alert" className="text-destructive text-xs">{view.unavailable}</span>}
      {error && <span role="alert" className="text-destructive text-xs">{error}</span>}
    </div>
  );
}
