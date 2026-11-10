import { MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteSession, type Session } from "./api.js";
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
import { SidebarMenuAction } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";

/** The actions on one sidebar entry, behind a menu that shows on hover or focus. */
export function SessionMenu({ session, onDelete }: { session: Session; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction showOnHover aria-label="Session actions">
          <MoreHorizontal />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
