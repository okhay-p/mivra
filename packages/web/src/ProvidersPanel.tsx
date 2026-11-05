import { ExternalLink } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { checkProviderKey, getProviderKeys, removeProviderKey, saveProviderKey, type ProviderId, type ProviderKey, type ProviderKeysView } from "./api.js";

const DETAILS: Record<ProviderId, { env: string; keysUrl: string; note: string }> = {
  openrouter: { env: "OPENROUTER_API_KEY", keysUrl: "https://openrouter.ai/keys", note: "One key reaches every model." },
  anthropic: { env: "ANTHROPIC_API_KEY", keysUrl: "https://console.anthropic.com/settings/keys", note: "Claude models, directly." },
  openai: { env: "OPENAI_API_KEY", keysUrl: "https://platform.openai.com/api-keys", note: "GPT models, directly." },
};

/** Whether any provider has a key; with none, the app opens this panel as first-run setup. */
export const hasAnyKey = (view: ProviderKeysView) => view.providers.some((p) => p.source !== null);

/** API keys for the model providers (ADR-013). Keys are write-only: the server only says where each one comes from. */
export function ProvidersPanel({
  open,
  onOpenChange,
  firstRun = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened because no key is set yet: explains that one is needed. */
  firstRun?: boolean;
}) {
  const [view, setView] = useState<ProviderKeysView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setError(undefined);
    void getProviderKeys().then((result) => {
      if (stale) return;
      if (result.ok) setView(result.value);
      else setError(result.error);
    });
    return () => {
      stale = true;
    };
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        // The opening button isn't the Sheet's trigger, and on mobile it unmounts with the sidebar.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = document.querySelector<HTMLElement>("[data-providers-trigger]") ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
          target?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle className="font-heading">Model providers</SheetTitle>
          <SheetDescription>
            {firstRun && view && !hasAnyKey(view)
              ? "Mivra needs an API key from one of these providers before it can teach. OpenRouter is the simplest: one key reaches every model."
              : "The API keys Mivra uses to reach models. Keys stay on this computer and are never shown again after you save them."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4" aria-live="polite">
          {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
          {!view && !error && <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Spinner aria-hidden="true" /> Loading providers…</p>}
          {view && !view.canEdit && (
            <p className="text-muted-foreground text-sm">
              Keys can only be changed on the computer running Mivra. There, open this panel or run <code>mivra auth set &lt;provider&gt;</code>.
            </p>
          )}
          {view?.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} canEdit={view.canEdit} onChange={setView} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type Status = { kind: "ok" | "error"; text: string } | undefined;

function ProviderRow({ provider, canEdit, onChange }: { provider: ProviderKey; canEdit: boolean; onChange: (view: ProviderKeysView) => void }) {
  const details = DETAILS[provider.id];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [status, setStatus] = useState<Status>();
  const inputId = `provider-key-${provider.id}`;

  const check = async () => {
    setActivity("Checking the key…");
    setBusy(true);
    setStatus(undefined);
    const result = await checkProviderKey(provider.id);
    setBusy(false);
    if (!result.ok) return setStatus({ kind: "error", text: result.error });
    setStatus(result.value.ok ? { kind: "ok", text: "The key works." } : { kind: "error", text: result.value.message ?? "The key didn't work." });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setActivity("Saving the key…");
    setBusy(true);
    setStatus(undefined);
    const result = await saveProviderKey(provider.id, draft);
    setBusy(false);
    if (!result.ok) return setStatus({ kind: "error", text: result.error });
    setDraft("");
    setEditing(false);
    onChange(result.value);
    // Saved either way; say right away whether the provider accepts it.
    await check();
  };

  const remove = async () => {
    setActivity("Removing the key…");
    setBusy(true);
    setStatus(undefined);
    const result = await removeProviderKey(provider.id);
    setBusy(false);
    if (!result.ok) return setStatus({ kind: "error", text: result.error });
    onChange(result.value);
  };

  const showForm = canEdit && provider.source !== "env" && (provider.source === null || editing);
  const hint = provider.hint ? ` · ends in ${provider.hint}` : "";

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3" aria-labelledby={`${inputId}-name`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={`${inputId}-name`} className="text-sm font-semibold">
          {provider.label}
        </h2>
        <a
          href={details.keysUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
        >
          Get a key <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
      <p id={`${inputId}-source`} className="text-muted-foreground text-xs">
        {provider.source === "env"
          ? `Set by ${details.env}${hint}. Change it there.`
          : provider.source === "saved"
            ? `Saved${hint}.`
            : `Not set. ${details.note}`}
      </p>
      {showForm ? (
        <form onSubmit={save}>
          <Field data-invalid={status?.kind === "error"}>
            <FieldLabel htmlFor={inputId}>{provider.label} API key</FieldLabel>
            <FieldDescription id={`${inputId}-description`}>Paste a key from your {provider.label} account.</FieldDescription>
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-0 flex-[1_1_10rem]"
                aria-describedby={`${inputId}-source ${inputId}-description${status ? ` ${inputId}-status` : ""}`}
                aria-invalid={status?.kind === "error"}
                id={inputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste your API key"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
              />
              <Button type="submit" disabled={busy || !draft.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
            {status?.kind === "error" && <FieldError id={`${inputId}-status`}>{status.text}</FieldError>}
          </Field>
        </form>
      ) : (
        provider.source !== null && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
              Check
            </Button>
            {canEdit && provider.source === "saved" && (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void remove()}>
                  Remove
                </Button>
              </>
            )}
          </div>
        )
      )}
      {busy && <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Spinner aria-hidden="true" /> {activity}</p>}
      {status && !(showForm && status.kind === "error") && <p id={`${inputId}-status`} className={status.kind === "ok" ? "text-success text-sm" : "text-destructive text-sm"}>{status.text}</p>}
    </section>
  );
}
