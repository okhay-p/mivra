import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { deleteSession, renameSession, type Session } from "./api.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarInput, SidebarMenuAction } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";

/** The longest title the server accepts. */
const MAX_TITLE = 120;

/** The actions on one sidebar entry, behind a menu that shows on hover or focus. */
export function SessionMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  // Rename moves focus into the title field, so the menu mustn't hand it back to its trigger on closing.
  const renaming = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction showOnHover aria-label="Session actions">
          <MoreHorizontal />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        onCloseAutoFocus={(event) => {
          if (!renaming.current) return;
          renaming.current = false;
          event.preventDefault();
          onRename();
        }}
      >
        <DropdownMenuItem onSelect={() => (renaming.current = true)}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Edits a sidebar entry's title in place of its button. Enter or leaving the field saves, Esc cancels;
 * an empty or unchanged title saves nothing. A failure keeps the field open with the error below it.
 */
export function SessionTitleEditor({
  session,
  onDone,
  onRenamed,
}: {
  session: Session;
  onDone: () => void;
  onRenamed: (session: Session) => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  // Enter and Esc end editing, and the field's blur that follows mustn't save a second time.
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const save = async () => {
    if (finished.current || saving) return;
    const next = title.trim();
    if (!next || next === session.title) {
      finished.current = true;
      return onDone();
    }
    setSaving(true);
    setError(undefined);
    const result = await renameSession(session.id, next);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      input.current?.focus();
      return;
    }
    finished.current = true;
    onRenamed(result.value);
    onDone();
  };

  return (
    <div className="px-0.5 py-0.5">
      <SidebarInput
        ref={input}
        value={title}
        maxLength={MAX_TITLE}
        readOnly={saving}
        aria-label="Title"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `rename-error-${session.id}` : undefined}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            // Esc would also close the mobile sidebar around this field.
            e.stopPropagation();
            finished.current = true;
            onDone();
          }
        }}
        onBlur={() => void save()}
      />
      {error && (
        <p id={`rename-error-${session.id}`} className="text-destructive px-1 pt-1 text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Asks before deleting a session; `session` set opens it. */
export function DeleteSessionDialog({
  session,
  onClose,
  onDeleted,
}: {
  session: Session | undefined;
  onClose: () => void;
  onDeleted: (session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const confirm = async () => {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    const result = await deleteSession(session.id);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onDeleted(session);
  };

  return (
    <AlertDialog
      open={Boolean(session)}
      onOpenChange={(open) => {
        if (open || busy) return;
        setError(undefined);
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-heading wrap-anywhere">Delete “{session?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {session?.courseId
              ? "This deletes the course with its syllabus, lessons and every lesson's chat. It can't be undone. What Mivra remembers about you is kept."
              : "This deletes the session with its messages and attached documents. It can't be undone. What Mivra remembers about you is kept."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              // Stay open until the server answers, so a failure can be shown here.
              event.preventDefault();
              void confirm();
            }}
          >
            {busy && <Spinner />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
