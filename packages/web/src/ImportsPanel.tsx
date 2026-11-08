import type { VaultImportResult, VaultImportView } from "@mivra/protocol";
import { FileArchive, FolderOpen, Library } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { deleteImport, importVaultFiles, importVaultZip, listImports, type ImportTarget } from "./api.js";
import { readPickedVault, type PickedVault } from "./vault-files.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** Imported Obsidian vaults (ADR-014): their notes are read-only here and change only when the vault is imported again. */
export function ImportsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [imports, setImports] = useState<VaultImportView[]>();
  const [error, setError] = useState<string>();
  /** The dialog, for a new import or a re-import of one. */
  const [dialog, setDialog] = useState<{ reimport?: VaultImportView }>();

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setImports(undefined);
    setError(undefined);
    setDialog(undefined);
    void listImports().then((result) => {
      if (stale) return;
      if (result.ok) setImports(result.value);
      else setError(result.error);
    });
    return () => {
      stale = true;
    };
  }, [open]);

  const imported = ({ import: view }: VaultImportResult) =>
    setImports((all = []) => (all.some((i) => i.id === view.id) ? all.map((i) => (i.id === view.id ? view : i)) : [...all, view]));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        // The opening button isn't the Sheet's trigger, and on mobile it unmounts with the sidebar.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = document.querySelector<HTMLElement>("[data-imports-trigger]") ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
          target?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle className="font-heading">Imported notes</SheetTitle>
          <SheetDescription>Notes from your Obsidian vaults. They're read-only here: edit them in Obsidian, then re-import the vault.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4" aria-live="polite">
          {imports && imports.length > 0 && (
            <Button type="button" className="self-start" onClick={() => setDialog({})}>
              <FolderOpen aria-hidden="true" />
              Import a vault
            </Button>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
          {!imports && !error && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
              <Spinner aria-hidden="true" /> Loading imports…
            </p>
          )}
          {imports?.length === 0 && (
            <Empty className="border p-6 md:p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Library aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No vaults imported yet</EmptyTitle>
                <EmptyDescription>Import an Obsidian vault to bring its notes, links and tags into Mivra. Only Markdown notes are read.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" onClick={() => setDialog({})}>
                  <FolderOpen aria-hidden="true" />
                  Import a vault
                </Button>
              </EmptyContent>
            </Empty>
          )}
          {imports && imports.length > 0 && (
            <ul className="flex flex-col gap-2" aria-label="Imported vaults">
              {imports.map((entry) => (
                <ImportEntry key={entry.id} entry={entry} onReimport={() => setDialog({ reimport: entry })} onDelete={() => setImports((all) => all?.filter((i) => i.id !== entry.id))} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
      <ImportDialog
        open={dialog !== undefined}
        onOpenChange={(next) => {
          if (!next) setDialog(undefined);
        }}
        imports={imports ?? []}
        {...(dialog?.reimport ? { reimport: dialog.reimport } : {})}
        onImported={imported}
      />
    </Sheet>
  );
}

function ImportEntry({ entry, onReimport, onDelete }: { entry: VaultImportView; onReimport: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const result = await deleteImport(entry.id);
    setBusy(false);
    if (result.ok) onDelete();
    else setError(result.error);
  };
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3 text-sm wrap-anywhere" aria-label={entry.name}>
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{entry.name}</span>
        <span className="text-muted-foreground text-xs">
          {plural(entry.noteCount, "note")} · Updated {new Date(entry.updatedAt).toLocaleDateString()}
        </span>
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Delete this import and its {plural(entry.noteCount, "note")}? Your vault itself isn't touched.</span>
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
            {busy && <Spinner aria-hidden="true" />}
            Yes, delete
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onReimport}>
            Re-import
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

type Source = { kind: "folder"; vault: PickedVault } | { kind: "zip"; file: File };
type Step =
  | { step: "choose"; error?: string }
  | { step: "reading"; read: number; total: number }
  | { step: "ready"; source: Source; error?: string }
  | { step: "sending"; source: Source }
  | { step: "done"; result: VaultImportResult; source: Source; replaced: boolean };

const zipBaseName = (name: string) => name.replace(/\.zip$/i, "").trim();
const defaultName = (source: Source) => (source.kind === "zip" ? zipBaseName(source.file.name) : (source.vault.folder ?? "")).slice(0, 120);

/** Picks a vault folder (or a .zip where folders can't be picked), reads its notes and sends them. */
export function ImportDialog({
  open,
  onOpenChange,
  imports,
  reimport,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing imports, so a name that's taken re-imports that vault. */
  imports: VaultImportView[];
  /** Re-imports this import instead of starting a new one. */
  reimport?: VaultImportView;
  onImported: (result: VaultImportResult) => void;
}) {
  const nameId = useId();
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<Step>({ step: "choose" });
  const [name, setName] = useState("");
  // A read still running when the dialog closes or starts over is ignored.
  const run = useRef(0);

  useEffect(() => {
    if (!open) return;
    run.current++;
    setState({ step: "choose" });
    setName("");
  }, [open]);

  const existing = reimport ?? imports.find((i) => i.name === name.trim());
  const target: ImportTarget = existing ? { importId: existing.id } : { name: name.trim() };

  const pickFolder = async (files: FileList) => {
    const current = ++run.current;
    setState({ step: "reading", read: 0, total: 0 });
    const result = await readPickedVault(files, (read, total) => {
      if (run.current === current) setState({ step: "reading", read, total });
    });
    if (run.current !== current) return;
    if (!result.ok) return setState({ step: "choose", error: result.error });
    if (result.vault.files.length === 0) return setState({ step: "choose", error: "No Markdown notes were found in this folder. Choose the folder that holds your vault's notes." });
    const source: Source = { kind: "folder", vault: result.vault };
    setName(defaultName(source));
    setState({ step: "ready", source });
  };
  const pickZip = (file: File) => {
    run.current++;
    const source: Source = { kind: "zip", file };
    setName(defaultName(source));
    setState({ step: "ready", source });
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (state.step !== "ready") return;
    const { source } = state;
    const current = ++run.current;
    setState({ step: "sending", source });
    const result = source.kind === "zip" ? await importVaultZip(target, source.file) : await importVaultFiles(target, source.vault.files);
    if (run.current !== current) return;
    if (!result.ok) return setState({ step: "ready", source, error: result.error });
    onImported(result.value);
    setState({ step: "done", result: result.value, source, replaced: Boolean(existing) });
  };

  const title = reimport ? `Re-import ${reimport.name}` : "Import an Obsidian vault";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-heading wrap-anywhere">{title}</DialogTitle>
          <DialogDescription>
            {reimport
              ? "Choose the same vault again. Changed notes are updated, new ones added, and notes that are gone from it removed."
              : "Choose your vault's folder. Only Markdown notes are read; attachments and hidden folders such as .obsidian are left out."}
          </DialogDescription>
        </DialogHeader>

        <input
          ref={folderInput}
          type="file"
          multiple
          className="hidden"
          data-testid="vault-folder-input"
          // Not in React's types, but every desktop browser supports it.
          {...({ webkitdirectory: "" } as object)}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void pickFolder(files);
            // Cleared so choosing the same folder again, say after an error, still fires a change.
            e.target.value = "";
          }}
        />
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          data-testid="vault-zip-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) pickZip(file);
          }}
        />

        {state.step === "choose" && (
          <div className="flex flex-col gap-3">
            <Field data-invalid={Boolean(state.error)}>
              <Button type="button" onClick={() => folderInput.current?.click()}>
                <FolderOpen aria-hidden="true" />
                Choose vault folder
              </Button>
              {state.error && <FieldError role="alert">{state.error}</FieldError>}
            </Field>
            <p className="text-muted-foreground text-sm">
              Can't choose a folder on this device?{" "}
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => zipInput.current?.click()}>
                Upload a .zip instead
              </Button>
            </p>
          </div>
        )}

        {state.step === "reading" && (
          <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Spinner aria-hidden="true" />
            {state.total > 0 ? `Reading notes… ${state.read.toLocaleString("en")} of ${state.total.toLocaleString("en")}` : "Looking through the folder…"}
          </p>
        )}

        {(state.step === "ready" || state.step === "sending") && (
          <form onSubmit={send} className="flex flex-col gap-4">
            <SourceSummary source={state.source} />
            {!reimport && (
              <Field data-invalid={state.step === "ready" && Boolean(state.error)}>
                <FieldLabel htmlFor={nameId}>Import name</FieldLabel>
                <Input id={nameId} value={name} maxLength={120} disabled={state.step === "sending"} onChange={(e) => setName(e.target.value)} aria-describedby={`${nameId}-description`} />
                <FieldDescription id={`${nameId}-description`}>
                  {existing
                    ? `An import called ${existing.name} already exists, so this re-imports it: changed notes are updated and notes that are gone are removed.`
                    : "Tells your imports apart. Import the same vault under this name again to update it."}
                </FieldDescription>
              </Field>
            )}
            {state.step === "ready" && state.error && (
              <FieldError role="alert" className="wrap-anywhere">
                {state.error}
              </FieldError>
            )}
            {state.step === "sending" && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                <Spinner aria-hidden="true" />
                {state.source.kind === "zip" ? "Uploading and unpacking the zip…" : `Sending ${plural(state.source.vault.files.length, "note")}…`}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={state.step === "sending"} onClick={() => setState({ step: "choose" })}>
                Choose again
              </Button>
              <Button type="submit" disabled={state.step === "sending" || (!reimport && !name.trim())}>
                {state.step === "sending" && <Spinner aria-hidden="true" />}
                {existing ? "Re-import" : "Import"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {state.step === "done" && (
          <div className="flex flex-col gap-4">
            <ResultSummary result={state.result} source={state.source} replaced={state.replaced} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourceSummary({ source }: { source: Source }) {
  if (source.kind === "zip") {
    return (
      <p className="flex items-center gap-2 text-sm wrap-anywhere">
        <FileArchive className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        {source.file.name} ({(source.file.size / (1024 * 1024)).toFixed(1)} MB)
      </p>
    );
  }
  const { vault } = source;
  const leftOut = [vault.notMarkdown > 0 && plural(vault.notMarkdown, "other file"), vault.tooLong.length > 0 && plural(vault.tooLong.length, "note") + " too long to import"].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="flex items-center gap-2 wrap-anywhere">
        <FolderOpen className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        {plural(vault.files.length, "note")} found{vault.folder ? ` in ${vault.folder}` : ""}
      </p>
      {leftOut.length > 0 && <p className="text-muted-foreground">Left out: {leftOut.join(", ")}.</p>}
    </div>
  );
}

const reasonLabel: Record<VaultImportResult["skipped"][number]["reason"], string> = {
  not_markdown: "not a note",
  hidden: "hidden",
  bad_path: "unsafe path",
  duplicate: "duplicate",
  too_long: "too long",
  symlink: "link to another file",
};

function ResultSummary({ result, source, replaced }: { result: VaultImportResult; source: Source; replaced: boolean }) {
  // The folder picker leaves attachments and long notes out before sending, so they're counted here.
  const localTooLong = source.kind === "folder" ? source.vault.tooLong : [];
  const localOther = source.kind === "folder" ? source.vault.notMarkdown : 0;
  const skipped = [...localTooLong.map((path) => ({ path, reason: "too_long" as const })), ...result.skipped];
  const skippedCount = result.skippedCount + localTooLong.length + localOther;
  const counts = [
    ["Added", result.added],
    ["Updated", result.updated],
    ["Removed", result.removed],
    ["Unchanged", result.unchanged],
  ] as const;
  return (
    <div className="flex flex-col gap-3 text-sm" role="status">
      <p className="wrap-anywhere">
        {replaced ? "Re-imported" : "Imported"} <span className="font-medium">{result.import.name}</span>: {plural(result.import.noteCount, "note")} in all.
      </p>
      <dl className="grid grid-cols-4 gap-2" aria-label="What changed">
        {counts.map(([label, value]) => (
          <div key={label} className="bg-muted flex flex-col rounded-md px-2 py-1.5">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="font-medium tabular-nums">{value.toLocaleString("en")}</dd>
          </div>
        ))}
      </dl>
      {skippedCount > 0 && (
        <div className="text-muted-foreground flex flex-col gap-1">
          <p>Skipped {plural(skippedCount, "file")}{localOther > 0 ? `, including ${plural(localOther, "attachment or other file", "attachments and other files")}` : ""}.</p>
          {skipped.length > 0 && (
            <ul className="list-disc pl-5 wrap-anywhere">
              {skipped.slice(0, 5).map((s) => (
                <li key={`${s.path}:${s.reason}`}>
                  {s.path} ({reasonLabel[s.reason]})
                </li>
              ))}
              {skipped.length > 5 && <li>…</li>}
            </ul>
          )}
        </div>
      )}
      {result.truncated && <p className="text-muted-foreground">Some links or tags were left out: a note or the vault had more than Mivra keeps.</p>}
    </div>
  );
}
