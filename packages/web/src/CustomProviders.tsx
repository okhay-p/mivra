import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  createCustomProvider,
  refreshCustomModels,
  removeCustomProvider,
  testCustomModel,
  updateCustomProvider,
  type CustomModelEntry,
  type CustomProvider,
  type ProviderKeysView,
} from "./api.js";

/**
 * Custom OpenAI-compatible providers (issue #69): a service the learner names, reached through its Chat Completions
 * API. Its key is write-only like the built-in ones; its models are entered by hand or picked from its own list, and
 * each can be tested for the streamed tool calling Mivra needs.
 */
export function CustomProviders({ custom, canEdit, onChange }: { custom: CustomProvider[]; canEdit: boolean; onChange: (view: ProviderKeysView) => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="custom-providers-heading">
      <div className="flex flex-col gap-1">
        <h2 id="custom-providers-heading" className="text-sm font-semibold">OpenAI-compatible providers</h2>
        <p className="text-muted-foreground text-xs">
          Any service with an OpenAI-compatible Chat Completions API, such as a local server or another provider. Compatibility varies: test each model before
          relying on it.
        </p>
      </div>
      {custom.map((provider) => (
        <CustomProviderCard key={provider.id} provider={provider} canEdit={canEdit} onChange={onChange} />
      ))}
      {canEdit &&
        (adding ? (
          <AddProvider onDone={() => setAdding(false)} onChange={onChange} />
        ) : (
          <Button type="button" variant="outline" className="self-start" onClick={() => setAdding(true)}>
            Add an OpenAI-compatible provider
          </Button>
        ))}
    </section>
  );
}

const BASE_URL_HELP =
  "The API base, including any version prefix, such as https://api.example.com/v1 or http://127.0.0.1:11434/v1. Not the full /chat/completions address.";

/** "a, b\nc" → ["a", "b", "c"]: ids may be separated by new lines, commas or spaces. */
const splitIds = (text: string) => [...new Set(text.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))];

function AddProvider({ onDone, onChange }: { onDone: () => void; onChange: (view: ProviderKeysView) => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [ids, setIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await createCustomProvider({
      name,
      baseUrl: baseUrl.trim() || null,
      ...(key.trim() ? { key: key.trim() } : {}),
      models: splitIds(ids).map((id) => ({ id })),
    });
    if (!result.ok) {
      setBusy(false);
      return setError(result.error);
    }
    onChange(result.value);
    // Offer its own list straight away; a failure is shown on the card and doesn't undo the save.
    const added = result.value.custom.at(-1);
    if (added?.baseUrl.value) {
      const refreshed = await refreshCustomModels(added.id);
      if (refreshed.ok) onChange(refreshed.value);
    }
    setBusy(false);
    onDone();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border p-3" aria-label="Add an OpenAI-compatible provider">
      <Field>
        <FieldLabel htmlFor="custom-new-name">Provider name</FieldLabel>
        <Input id="custom-new-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} autoComplete="off" placeholder="DeepSeek" />
      </Field>
      <Field>
        <FieldLabel htmlFor="custom-new-url">API base URL</FieldLabel>
        <FieldDescription id="custom-new-url-help">{BASE_URL_HELP}</FieldDescription>
        <Input id="custom-new-url" aria-describedby="custom-new-url-help" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy}
          autoComplete="off" spellCheck={false} inputMode="url" placeholder="https://api.example.com/v1" />
      </Field>
      <Field>
        <FieldLabel htmlFor="custom-new-key">API key</FieldLabel>
        <FieldDescription id="custom-new-key-help">Kept on this computer and never shown again. Leave it empty for a local server that needs none.</FieldDescription>
        <Input id="custom-new-key" aria-describedby="custom-new-key-help" type="password" value={key} onChange={(e) => setKey(e.target.value)} disabled={busy}
          autoComplete="off" spellCheck={false} placeholder="Paste your API key" />
      </Field>
      <Field>
        <FieldLabel htmlFor="custom-new-models">Model ids</FieldLabel>
        <FieldDescription id="custom-new-models-help">One per line, as the provider names them. You can also pick from its list after saving.</FieldDescription>
        <Textarea id="custom-new-models" aria-describedby="custom-new-models-help" value={ids} onChange={(e) => setIds(e.target.value)} disabled={busy}
          spellCheck={false} rows={2} placeholder="model-id" />
      </Field>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy && <Spinner aria-hidden="true" />}
          Save provider
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Status = { kind: "ok" | "error"; text: string } | undefined;

function CustomProviderCard({ provider, canEdit, onChange }: { provider: CustomProvider; canEdit: boolean; onChange: (view: ProviderKeysView) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [status, setStatus] = useState<Status>();
  const id = `custom-${provider.id}`;

  const run = async (what: string, action: () => Promise<{ ok: true; value: ProviderKeysView } | { ok: false; error: string }>) => {
    setActivity(what);
    setBusy(true);
    setStatus(undefined);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setStatus({ kind: "error", text: result.error });
      return false;
    }
    onChange(result.value);
    return true;
  };

  const saveModels = (models: CustomModelEntry[]) => run("Saving models…", () => updateCustomProvider(provider.id, { models }));
  const current = provider.models.map(({ id, contextLength, maxOutputTokens }) => ({ id, contextLength, maxOutputTokens }));

  const url = provider.baseUrl;
  const urlText = url.value
    ? `${url.value} · ${url.source === "env" ? `from ${provider.envNames.baseUrl}` : "saved"}`
    : `No API base URL. Set one here or with ${provider.envNames.baseUrl}.`;
  const keyText =
    provider.key.source === "env"
      ? `Key set by ${provider.envNames.key}${provider.key.hint ? ` · ends in ${provider.key.hint}` : ""}.`
      : provider.key.source === "saved"
        ? `Key saved${provider.key.hint ? ` · ends in ${provider.key.hint}` : ""}.`
        : "No key.";

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3" aria-labelledby={`${id}-name`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={`${id}-name`} className="text-sm font-semibold wrap-anywhere">{provider.name}</h3>
        <span className="text-muted-foreground text-xs">Chat Completions</span>
      </div>
      <div className="text-muted-foreground flex flex-col gap-0.5 text-xs wrap-anywhere">
        <p>{urlText}</p>
        {url.error && <p className="text-destructive">{url.error}</p>}
        <p>{keyText}</p>
      </div>

      {editing ? (
        <EditProvider provider={provider} onDone={() => setEditing(false)} onChange={onChange} />
      ) : (
        canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {url.source === "saved" && url.env && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("Resetting the URL…", () => updateCustomProvider(provider.id, { baseUrl: null }))}>
                Use {provider.envNames.baseUrl}
              </Button>
            )}
            {!confirming && (
              <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirming(true)}>
                Remove
              </Button>
            )}
          </div>
        )
      )}
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Remove {provider.name} and its saved key? Replies it wrote stay in your sessions.</span>
          <Button type="button" variant="destructive" size="sm" disabled={busy}
            onClick={() => void run("Removing…", () => removeCustomProvider(provider.id)).then((ok) => ok && setConfirming(false))}>
            Yes, remove
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      )}

      <ModelList provider={provider} canEdit={canEdit} busy={busy} onRemove={(modelId) => void saveModels(current.filter((m) => m.id !== modelId))} onChange={onChange} />
      {canEdit && <AddModel provider={provider} busy={busy} onAdd={(entry) => saveModels([...current, entry])} />}
      <Discovery provider={provider} busy={busy} onRefresh={() => void run("Loading the provider's models…", () => refreshCustomModels(provider.id))} />

      {busy && <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Spinner aria-hidden="true" /> {activity}</p>}
      {status && <p className={status.kind === "ok" ? "text-success text-sm" : "text-destructive text-sm"} role={status.kind === "error" ? "alert" : undefined}>{status.text}</p>}
    </section>
  );
}

function EditProvider({ provider, onDone, onChange }: { provider: CustomProvider; onDone: () => void; onChange: (view: ProviderKeysView) => void }) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl.source === "saved" ? (provider.baseUrl.value ?? "") : "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = `custom-${provider.id}-edit`;
  const keyFromEnv = provider.key.source === "env";

  const save = async (body: Parameters<typeof updateCustomProvider>[1]) => {
    setBusy(true);
    setError(undefined);
    const result = await updateCustomProvider(provider.id, body);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onChange(result.value);
    onDone();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({
      name,
      // Empty: no saved URL, so the environment's applies if it sets one.
      baseUrl: baseUrl.trim() || null,
      ...(key.trim() ? { key: key.trim() } : {}),
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={`Edit ${provider.name}`}>
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Provider name</FieldLabel>
        <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-url`}>API base URL</FieldLabel>
        <FieldDescription id={`${id}-url-help`}>
          {BASE_URL_HELP}
          {provider.baseUrl.env ? ` Leave it empty to use ${provider.envNames.baseUrl} (${provider.baseUrl.env}).` : ""} A new URL or key clears earlier test results.
        </FieldDescription>
        <Input id={`${id}-url`} aria-describedby={`${id}-url-help`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy}
          autoComplete="off" spellCheck={false} inputMode="url" placeholder={provider.baseUrl.env ?? "https://api.example.com/v1"} />
      </Field>
      {!keyFromEnv && (
        <Field>
          <FieldLabel htmlFor={`${id}-key`}>New API key</FieldLabel>
          <FieldDescription id={`${id}-key-help`}>Leave it empty to keep the current key.</FieldDescription>
          <Input id={`${id}-key`} aria-describedby={`${id}-key-help`} type="password" value={key} onChange={(e) => setKey(e.target.value)} disabled={busy}
            autoComplete="off" spellCheck={false} placeholder="Paste a new API key" />
        </Field>
      )}
      {error && <FieldError>{error}</FieldError>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          {busy && <Spinner aria-hidden="true" />}
          Save
        </Button>
        {!keyFromEnv && provider.key.source === "saved" && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save({ key: null })}>
            Remove saved key
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const STATUS_BADGE: Record<CustomProvider["models"][number]["verification"]["status"], { text: string; className: string }> = {
  unverified: { text: "Not tested", className: "" },
  verified: { text: "Works", className: "text-success" },
  failed: { text: "Test failed", className: "text-destructive" },
};

function ModelList({ provider, canEdit, busy, onRemove, onChange }: {
  provider: CustomProvider;
  canEdit: boolean;
  busy: boolean;
  onRemove: (modelId: string) => void;
  onChange: (view: ProviderKeysView) => void;
}) {
  const [testing, setTesting] = useState<string>();
  const [results, setResults] = useState<Record<string, Status>>({});
  const abort = useRef<AbortController>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  if (provider.models.length === 0) {
    return <p className="text-muted-foreground text-sm">No models yet. Add a model id{provider.baseUrl.value ? " or pick one from the provider's list" : ""}.</p>;
  }

  const test = async (modelId: string) => {
    const controller = new AbortController();
    abort.current = controller;
    setTesting(modelId);
    setResults((r) => ({ ...r, [modelId]: undefined }));
    const result = await testCustomModel(provider.id, modelId, controller.signal);
    setTesting(undefined);
    if (controller.signal.aborted) return setResults((r) => ({ ...r, [modelId]: { kind: "error", text: "Test cancelled." } }));
    if (!result.ok) return setResults((r) => ({ ...r, [modelId]: { kind: "error", text: result.error } }));
    onChange(result.value.providers);
    setResults((r) => ({ ...r, [modelId]: { kind: result.value.result.ok ? "ok" : "error", text: result.value.result.message } }));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">Test model sends a short request with a tool call, which may use a few tokens.</p>
      <ul className="flex flex-col gap-2" aria-label={`${provider.name} models`}>
        {provider.models.map((model) => {
          const badge = STATUS_BADGE[model.verification.status];
          const result = results[model.id];
          const limits = [model.contextLength && `${model.contextLength.toLocaleString()} context`, model.maxOutputTokens && `${model.maxOutputTokens.toLocaleString()} max output`].filter(Boolean).join(" · ");
          return (
            <li key={model.id} className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-sm" aria-label={model.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">{model.id}</span>
                <Badge variant="outline" className={badge.className}>{badge.text}</Badge>
              </div>
              {limits && <span className="text-muted-foreground text-xs">{limits}</span>}
              {!result && model.verification.status === "failed" && model.verification.message && (
                <span className="text-destructive text-xs">{model.verification.message}</span>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {testing === model.id ? (
                  <>
                    <span className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status"><Spinner aria-hidden="true" /> Testing {model.id}…</span>
                    <Button size="xs" variant="outline" onClick={() => abort.current?.abort()}>Cancel test</Button>
                  </>
                ) : (
                  <Button size="xs" variant="outline" disabled={busy || testing !== undefined || !provider.baseUrl.value} onClick={() => void test(model.id)}
                    aria-label={`Test model ${model.id}`}>
                    Test model
                  </Button>
                )}
                {canEdit && (
                  <Button size="xs" variant="ghost" className="text-destructive" disabled={busy || testing === model.id} onClick={() => onRemove(model.id)}
                    aria-label={`Remove model ${model.id}`}>
                    Remove
                  </Button>
                )}
              </div>
              {result && <span className={result.kind === "ok" ? "text-success text-xs" : "text-destructive text-xs"} role="status">{result.text}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AddModel({ provider, busy, onAdd }: { provider: CustomProvider; busy: boolean; onAdd: (entry: CustomModelEntry) => Promise<boolean> }) {
  const [modelId, setModelId] = useState("");
  const [context, setContext] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string>();
  const id = `custom-${provider.id}-add`;
  const listId = `${id}-suggestions`;
  const added = new Set(provider.models.map((m) => m.id));
  const offered = provider.discovery.ids.filter((m) => !added.has(m));
  const limit = (text: string) => (text.trim() ? Number(text.trim().replace(/[,_]/g, "")) : null);
  const valid = (n: number | null) => n === null || (Number.isInteger(n) && n > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const entry = modelId.trim();
    if (!entry) return;
    setError(undefined);
    if (!valid(limit(context)) || !valid(limit(output))) return setError("Limits are whole numbers of tokens, such as 128000.");
    if (await onAdd({ id: entry, contextLength: limit(context), maxOutputTokens: limit(output) })) {
      setModelId("");
      setContext("");
      setOutput("");
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-label={`Add a model to ${provider.name}`}>
      <Field>
        <FieldLabel htmlFor={id}>Add a model id</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input id={id} className="min-w-0 flex-[1_1_10rem] font-mono" list={offered.length ? listId : undefined} value={modelId} onChange={(e) => setModelId(e.target.value)}
            disabled={busy} autoComplete="off" spellCheck={false} placeholder={offered[0] ?? "model-id"} />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !modelId.trim()}>Add</Button>
        </div>
        {offered.length > 0 && (
          <datalist id={listId}>
            {offered.slice(0, 500).map((m) => <option key={m} value={m} />)}
          </datalist>
        )}
      </Field>
      {error && <FieldError>{error}</FieldError>}
      <details className="text-sm">
        <summary className="text-muted-foreground cursor-pointer text-xs">Advanced: limits</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">Only if you know them. Mivra doesn't guess a model's limits; the output limit caps each reply.</p>
          <div className="flex flex-wrap gap-2">
            <Field className="flex-[1_1_8rem]">
              <FieldLabel htmlFor={`${id}-context`}>Context length</FieldLabel>
              <Input id={`${id}-context`} inputMode="numeric" value={context} onChange={(e) => setContext(e.target.value)} disabled={busy} placeholder="Unknown" />
            </Field>
            <Field className="flex-[1_1_8rem]">
              <FieldLabel htmlFor={`${id}-output`}>Max output tokens</FieldLabel>
              <Input id={`${id}-output`} inputMode="numeric" value={output} onChange={(e) => setOutput(e.target.value)} disabled={busy} placeholder="Provider default" />
            </Field>
          </div>
        </div>
      </details>
    </form>
  );
}

function Discovery({ provider, busy, onRefresh }: { provider: CustomProvider; busy: boolean; onRefresh: () => void }) {
  const d = provider.discovery;
  const when = d.fetchedAt ? new Date(d.fetchedAt).toLocaleString() : undefined;
  const text =
    d.state === "fresh"
      ? `The provider lists ${d.ids.length} ${d.ids.length === 1 ? "model" : "models"}. Type in the field above to pick one.`
      : d.state === "stale"
        ? `Showing the list from ${when}: ${d.error}`
        : d.state === "failed"
          ? d.error
          : "Load the provider's own list of models, or enter ids by hand.";
  return (
    <div className="flex flex-col gap-1.5">
      <p className={d.state === "failed" || d.state === "stale" ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>{text}</p>
      <Button type="button" size="sm" variant="outline" className="self-start" disabled={busy || !provider.baseUrl.value} onClick={onRefresh}>
        Refresh models
      </Button>
    </div>
  );
}
