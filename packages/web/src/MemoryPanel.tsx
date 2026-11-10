import type { MemoryKind, MemoryView } from "@mivra/protocol";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Brain } from "lucide-react";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { deleteImportedMemories, deleteMemory, editMemory, listMemories } from "./api.js";
import { ExportVault } from "./ExportVault.js";

const SECTIONS: { kind: MemoryKind; title: string }[] = [
  { kind: "goal", title: "Goals" },
  { kind: "preference", title: "Preferences" },
  { kind: "misconception", title: "Misconceptions" },
  { kind: "known", title: "Known from your notes" },
];

type Filter = "all" | "import" | "other";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "import", label: "From notes" },
  { value: "other", label: "From learning" },
];
const matches = (filter: Filter, memory: MemoryView) => filter === "all" || (filter === "import") === (memory.basis === "import");

const basisLabel = (memory: MemoryView) =>
  memory.basis === "import" ? (memory.source ? `From your note ${memory.source.title}` : "From your notes") : memory.basis === "wrong_answer" ? "From a wrong answer" : "From chat";

/** Everything Mivra has inferred about the learner, for them to check, correct or delete (ADR-009). */
export function MemoryPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [memories, setMemories] = useState<MemoryView[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const fromNotes = memories?.filter((m) => m.basis === "import").length ?? 0;
  const shown = memories?.filter((m) => matches(filter, m));

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setMemories(undefined);
    setFilter("all");
    const load = () => {
      setError(undefined);
      void listMemories().then((result) => {
        if (stale) return;
        if (result.ok) setMemories(result.value);
        else setError(result.error);
      });
    };
    load();
    // A check answered in another tab releases held memories.
    window.addEventListener("focus", load);
    return () => {
      stale = true;
      window.removeEventListener("focus", load);
    };
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        // The opening button isn't the Sheet's trigger, and on mobile it unmounts with the sidebar.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = document.querySelector<HTMLElement>("[data-memory-trigger]") ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
          target?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle className="font-heading">Memory</SheetTitle>
          <SheetDescription>What Mivra has noted about you across sessions. It can be wrong, so correct or delete anything here.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4 pb-4" aria-live="polite">
          {error && <p className="text-destructive text-sm">{error}</p>}
          {!memories && !error && <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Spinner aria-hidden="true" /> Loading memories…</p>}
          {memories?.length === 0 && (
            <Empty className="border p-6 md:p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Brain aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>No memories yet</EmptyTitle>
                <EmptyDescription>Start a conversation or course. As you learn, Mivra can remember your goals, preferences and concepts to revisit.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button variant="outline" onClick={() => onOpenChange(false)}>Back to learning</Button></EmptyContent>
            </Empty>
          )}
          {fromNotes > 0 && (
            <ImportedFilter
              filter={filter}
              onFilter={setFilter}
              count={fromNotes}
              onDeleted={() => {
                setMemories((all) => all?.filter((m) => m.basis !== "import"));
                setFilter("all");
              }}
            />
          )}
          {shown &&
            SECTIONS.map(({ kind, title }) => {
              const entries = shown.filter((m) => m.kind === kind);
              return entries.length > 0 ? (
                <section key={kind} className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold">{title}</h2>
                  <ul className="flex flex-col gap-2">
                    {entries.map((memory) => (
                      <MemoryEntry
                        key={memory.id}
                        memory={memory}
                        onChange={(next) => setMemories((all) => all?.map((m) => (m.id === next.id ? next : m)))}
                        onDelete={() => setMemories((all) => all?.filter((m) => m.id !== memory.id))}
                      />
                    ))}
                  </ul>
                </section>
              ) : null;
            })}
          {memories && memories.length > 0 && <ExportVault />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Shows only the memories drawn from imported notes (ADR-014), or the others, and deletes all of the first at once. */
function ImportedFilter({ filter, onFilter, count, onDeleted }: { filter: Filter; onFilter: (filter: Filter) => void; count: number; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const result = await deleteImportedMemories();
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setConfirming(false);
    onDeleted();
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Show memories">
        {FILTERS.map(({ value, label }) => (
          <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => onFilter(value)}>
            {label}
          </Button>
        ))}
      </div>
      {filter === "import" &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Delete all {count.toLocaleString("en")} memories drawn from your notes? Your notes stay imported.</span>
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
              {busy && <Spinner aria-hidden="true" />}
              Yes, delete all
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setConfirming(true)}>
            Delete all from notes
          </Button>
        ))}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function MemoryEntry({
  memory,
  onChange,
  onDelete,
}: {
  memory: MemoryView;
  onChange: (memory: MemoryView) => void;
  onDelete: () => void;
}) {
  const inputId = useId();
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [draft, setDraft] = useState(memory.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await editMemory(memory.id, draft);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onChange(result.value);
    setMode("view");
  };
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const result = await deleteMemory(memory.id);
    setBusy(false);
    if (result.ok) onDelete();
    else setError(result.error);
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3 text-sm wrap-anywhere">
      {mode === "edit" ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor={inputId}>Memory text</FieldLabel>
            <Textarea id={inputId} aria-describedby={`${inputId}-description${error ? ` ${inputId}-error` : ""}`} aria-invalid={Boolean(error)} value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <FieldDescription id={`${inputId}-description`}>Correct what Mivra should remember. Up to 300 characters.</FieldDescription>
            {error && <FieldError id={`${inputId}-error`} role="alert">{error}</FieldError>}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
              {busy && <Spinner aria-hidden="true" />}
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(memory.text ?? "");
                setError(undefined);
                setMode("view");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {memory.held ? <p className="text-muted-foreground italic">Hidden until you answer the check in that session.</p> : <p>{memory.text}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {!memory.held && (
              <Badge variant="outline" className="max-w-full truncate" title={memory.source ? `${memory.source.importName}: ${memory.source.path}` : undefined}>
                {basisLabel(memory)}
              </Badge>
            )}
            {memory.editedAt && <Badge variant="outline">Edited by you</Badge>}
            <span className="text-muted-foreground text-xs">{new Date(memory.createdAt).toLocaleDateString()}</span>
          </div>
          {mode === "confirm-delete" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Delete permanently?</span>
              <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
                Yes, delete
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setMode("view")}>
                Keep
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              {!memory.held && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(memory.text ?? "");
                    setMode("edit");
                  }}
                >
                  Edit
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => setMode("confirm-delete")}>
                Delete
              </Button>
            </div>
          )}
        </>
      )}
      {error && mode !== "edit" && <p className="text-destructive" role="alert">{error}</p>}
    </li>
  );
}
