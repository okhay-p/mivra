import type { MemoryKind, MemoryView } from "@mivra/protocol";
import { useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { deleteMemory, editMemory, listMemories } from "./api.js";

const SECTIONS: { kind: MemoryKind; title: string }[] = [
  { kind: "goal", title: "Goals" },
  { kind: "preference", title: "Preferences" },
  { kind: "misconception", title: "Misconceptions" },
];

/** Everything Mivra has inferred about the learner, for them to check, correct or delete (ADR-009). */
export function MemoryPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [memories, setMemories] = useState<MemoryView[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setMemories(undefined);
    setError(undefined);
    void listMemories().then((result) => {
      if (stale) return;
      if (result.ok) setMemories(result.value);
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
          {memories?.length === 0 && <p className="text-muted-foreground text-sm">Nothing yet.</p>}
          {memories &&
            SECTIONS.map(({ kind, title }) => {
              const entries = memories.filter((m) => m.kind === kind);
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
        </div>
      </SheetContent>
    </Sheet>
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
          <Textarea aria-label="Memory text" value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
              Save
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
            {!memory.held && <Badge variant="outline">{memory.basis === "wrong_answer" ? "From a wrong answer" : "From chat"}</Badge>}
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
                <Button type="button" variant="outline" size="sm" onClick={() => setMode("edit")}>
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
      {error && <p className="text-destructive">{error}</p>}
    </li>
  );
}
