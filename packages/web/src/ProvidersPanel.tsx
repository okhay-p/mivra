import { ExternalLink } from "lucide-react";
import { ChatGptMark } from "@/components/chatgpt-mark";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  PROVIDERS_CHANGED,
  cancelChatGptSignIn,
  checkChatGpt,
  checkProviderKey,
  completeChatGptSignIn,
  getProviderKeys,
  removeProviderKey,
  saveProviderKey,
  signOutChatGpt,
  startChatGptSignIn,
  type ChatGptSignIn,
  type ProviderId,
  type ProviderKey,
  type ProviderKeysView,
} from "./api.js";
import { ContinueWithChatGptButton, ManageUsageLink } from "./ChatGpt.js";

const DETAILS: Record<ProviderId, { env: string; keysUrl: string; note: string }> = {
  openrouter: { env: "OPENROUTER_API_KEY", keysUrl: "https://openrouter.ai/keys", note: "One key reaches every model." },
  anthropic: { env: "ANTHROPIC_API_KEY", keysUrl: "https://console.anthropic.com/settings/keys", note: "Claude models, directly." },
  openai: { env: "OPENAI_API_KEY", keysUrl: "https://platform.openai.com/api-keys", note: "GPT models, directly." },
};

/** Whether any provider is set up (a key, or a ChatGPT sign-in); with none, the app opens this panel as first-run setup. */
export const hasAnyKey = (view: ProviderKeysView) => view.providers.some((p) => p.source !== null) || Boolean(view.chatgpt?.signedIn);

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
              ? "Mivra needs a model provider before it can teach: sign in with ChatGPT, or add an API key from one of these providers. OpenRouter is the simplest key: one key reaches every model."
              : "How Mivra reaches models. Keys and sign-ins stay on this computer, and keys are never shown again after you save them."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4" aria-live="polite">
          {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
          {!view && !error && <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Spinner aria-hidden="true" /> Loading providers…</p>}
          {view && !view.canEdit && (
            <p className="text-muted-foreground text-sm">
              API keys can only be changed on the computer running Mivra. There, open this panel or run <code>mivra auth set &lt;provider&gt;</code>.
            </p>
          )}
          {view?.chatgpt && <ChatGptRow chatgpt={view.chatgpt} canEdit={view.canEdit} onChange={setView} />}
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

/** How often to ask whether a sign-in waiting on the browser has finished. */
const SIGN_IN_POLL_MS = 1500;

/**
 * Sign in with ChatGPT (ADR-015): use the learner's Plus or Pro plan instead of an API key. Wording follows
 * OpenAI's guidelines. A browser on another machine (over a tailnet, say) can sign in too: ChatGPT sends it back to
 * its own 127.0.0.1, which fails, so the learner pastes that address here.
 */
function ChatGptRow({ chatgpt, canEdit, onChange }: { chatgpt: ChatGptSignIn; canEdit: boolean; onChange: (view: ProviderKeysView) => void }) {
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [status, setStatus] = useState<Status>();
  const [address, setAddress] = useState("");
  /** The sign-in page, when the browser blocked opening it. */
  const [link, setLink] = useState<string>();
  const id = "provider-chatgpt";
  /** `canEdit` means this browser runs on the server's machine, so ChatGPT can send it straight back. */
  const local = canEdit;

  // While the browser is out at ChatGPT, watch for the server to finish the sign-in.
  useEffect(() => {
    if (!chatgpt.pending) return;
    const timer = setInterval(() => {
      void getProviderKeys().then((result) => {
        if (!result.ok || result.value.chatgpt?.pending) return;
        onChange(result.value);
        setLink(undefined);
        // The model picker lists ChatGPT's models once signed in, and the welcome shows.
        window.dispatchEvent(new Event(PROVIDERS_CHANGED));
      });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [chatgpt.pending, onChange]);

  const run = async <T,>(what: string, action: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>) => {
    setActivity(what);
    setBusy(true);
    setStatus(undefined);
    const result = await action();
    setBusy(false);
    if (!result.ok) setStatus({ kind: "error", text: result.error });
    return result.ok ? result.value : undefined;
  };

  const signIn = async (newAccount = false) => {
    // Open the tab now, while the click still allows it; it's pointed at ChatGPT once the server answers.
    const tab = window.open("about:blank", "_blank");
    const started = await run("Opening ChatGPT…", () => startChatGptSignIn(newAccount));
    if (!started) {
      tab?.close();
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = started.url;
    } else {
      setLink(started.url);
    }
    const refreshed = await getProviderKeys();
    if (refreshed.ok) onChange(refreshed.value);
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;
    const view = await run("Finishing sign-in…", () => completeChatGptSignIn(address));
    if (!view) return;
    setAddress("");
    setLink(undefined);
    onChange(view);
  };

  const cancel = async () => {
    const view = await run("Cancelling…", cancelChatGptSignIn);
    setLink(undefined);
    if (view) onChange(view);
  };

  const disconnect = async () => {
    const view = await run("Disconnecting…", signOutChatGpt);
    if (view) onChange(view);
  };

  const check = async () => {
    const result = await run("Checking the connection…", checkChatGpt);
    if (result) setStatus(result.ok ? { kind: "ok", text: "The connection works." } : { kind: "error", text: result.message ?? "The connection didn't work." });
  };

  const description = chatgpt.signedIn
    ? "Replies from ChatGPT models use your ChatGPT plan, not an API key."
    : chatgpt.pending
      ? "Finish connecting in your browser."
      : chatgpt.previous && chatgpt.notice
        ? "Reconnect to renew your ChatGPT connection."
        : "Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.";

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3" aria-labelledby={`${id}-name`}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-name`} className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <ChatGptMark className="size-4" />
          ChatGPT
        </h2>
        {chatgpt.signedIn && <Badge variant="secondary">Connected</Badge>}
      </div>
      {chatgpt.signedIn ? (
        <p className="text-sm">
          <span className="font-medium">{chatgpt.name ?? "Connected with ChatGPT"}</span>
          {chatgpt.email && <span className="text-muted-foreground block text-xs">{chatgpt.email}</span>}
        </p>
      ) : (
        !chatgpt.pending && <p className="text-sm font-medium">{chatgpt.previous && chatgpt.notice ? "Reconnect to ChatGPT" : "Use your ChatGPT plan"}</p>
      )}
      <p className="text-muted-foreground text-xs">{description}</p>
      {chatgpt.notice && !chatgpt.pending && <p className="text-destructive text-sm" role="alert">{chatgpt.notice}</p>}

      {chatgpt.pending ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Spinner aria-hidden="true" /> Waiting for you to approve Mivra in the ChatGPT tab…
          </p>
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2">
              Open the ChatGPT sign-in page
            </a>
          )}
          <form onSubmit={finish}>
            <Field data-invalid={status?.kind === "error"}>
              <FieldLabel htmlFor={`${id}-address`}>{local ? "Browser showing an error page?" : "Paste the address from the ChatGPT tab"}</FieldLabel>
              <FieldDescription id={`${id}-address-description`}>
                {local
                  ? "After approving, if the tab can't load, copy its whole address and paste it here."
                  : "This browser isn't on the computer running Mivra, so after you approve, the tab will show an error page. Copy its whole address and paste it here."}
              </FieldDescription>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-0 flex-[1_1_10rem]"
                  id={`${id}-address`}
                  aria-describedby={`${id}-address-description${status ? ` ${id}-status` : ""}`}
                  aria-invalid={status?.kind === "error"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="http://127.0.0.1:1455/auth/callback?code=…"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  disabled={busy}
                />
                <Button type="submit" disabled={busy || !address.trim()}>
                  Finish
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                  Cancel
                </Button>
              </div>
              {status?.kind === "error" && <FieldError id={`${id}-status`}>{status.text}</FieldError>}
            </Field>
          </form>
        </div>
      ) : chatgpt.signedIn ? (
        <div className="flex flex-wrap items-center gap-2">
          <ManageUsageLink primary />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
            Check
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <ContinueWithChatGptButton busy={busy} disabled={busy} onClick={() => void signIn()} />
          {chatgpt.previous && (
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
              Signs in as {chatgpt.previous}.
              <Button size="xs" variant="link" className="h-auto p-0" disabled={busy} onClick={() => void signIn(true)}>
                Use a different account
              </Button>
            </p>
          )}
        </div>
      )}
      {busy && (chatgpt.signedIn || chatgpt.pending) && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Spinner aria-hidden="true" /> {activity}</p>
      )}
      {status && !(chatgpt.pending && status.kind === "error") && (
        <p id={`${id}-status`} className={status.kind === "ok" ? "text-success text-sm" : "text-destructive text-sm"}>{status.text}</p>
      )}
    </section>
  );
}
