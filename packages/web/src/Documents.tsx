import { MAX_DOCUMENT_BYTES, type DocumentView } from "@mivra/protocol";
import { FileText, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteDocument, listDocuments, uploadDocument } from "./api.js";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

const NOT_READ = "Only text is read: images and diagrams aren't, and formulas may come through garbled.";

/** Uploads outlive the view that started them, which unmounts when the learner changes session. */
const uploadListeners = new Set<(sessionId: string) => void>();

/**
 * A session's documents. A response for a session that's no longer showing is dropped; the upload itself
 * still completes there, and a view showing that session again by then refreshes its list.
 */
export function useDocuments(sessionId: string) {
  const [documents, setDocuments] = useState<DocumentView[]>([]);
  const [uploading, setUploading] = useState<string>();
  const [error, setError] = useState<string>();
  // The session on screen, read when a response arrives to see if it's still wanted.
  const current = useRef(sessionId);
  current.current = sessionId;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setDocuments([]);
    setUploading(undefined);
    setError(undefined);
    let stale = false;
    const refresh = () =>
      void listDocuments(sessionId).then((result) => {
        if (stale) return;
        if (result.ok) setDocuments((uploaded) => [...result.value, ...uploaded.filter((d) => !result.value.some((v) => v.id === d.id))]);
        else setError(result.error);
      });
    refresh();
    const onUploadFinished = (finished: string) => {
      if (finished === sessionId) refresh();
    };
    uploadListeners.add(onUploadFinished);
    return () => {
      stale = true;
      uploadListeners.delete(onUploadFinished);
    };
  }, [sessionId]);

  const refresh = useCallback(async () => {
    const result = await listDocuments(sessionId);
    if (!mounted.current || current.current !== sessionId) return;
    if (result.ok) setDocuments(prev => [...result.value, ...prev.filter(d => !result.value.some(v => v.id === d.id))]);
    else setError(result.error);
  }, [sessionId]);

  const upload = useCallback(
    async (file: File) => {
      setError(undefined);
      if (file.size > MAX_DOCUMENT_BYTES) return setError(`${file.name} is over the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit.`);
      setUploading(file.name);
      const result = await uploadDocument(sessionId, file);
      if (!mounted.current) {
        if (result.ok) for (const listener of uploadListeners) listener(sessionId);
        return;
      }
      if (current.current !== sessionId) return;
      setUploading(undefined);
      if (result.ok) setDocuments((prev) => [...prev.filter((d) => d.id !== result.value.id), result.value]);
      else setError(result.error);
    },
    [sessionId],
  );

  const remove = useCallback(
    async (id: string) => {
      setError(undefined);
      const result = await deleteDocument(id);
      if (current.current !== sessionId) return;
      if (result.ok) setDocuments((prev) => prev.filter((d) => d.id !== id));
      else setError(result.error);
    },
    [sessionId],
  );

  return { documents, uploading, error, upload, remove, refresh };
}

export type Documents = ReturnType<typeof useDocuments>;

function pageLabel({ kind, pageCount, pagesWithText }: DocumentView): string {
  const unit = kind === "pptx" ? "slide" : "page";
  const pages = `${pageCount} ${unit}${pageCount === 1 ? "" : "s"}`;
  return pagesWithText < pageCount ? `${pages}, ${pagesWithText} with text` : pages;
}

export function AttachButton({ documents: { uploading, upload } }: { documents: Documents }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".pdf,.pptx"
        className="hidden"
        data-testid="document-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the same file again, say after an error, still fires a change.
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Attach a PDF or PowerPoint file" disabled={uploading !== undefined} onClick={() => input.current?.click()}>
              {uploading !== undefined ? <Spinner aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Attach a PDF or PowerPoint file</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </>
  );
}

/** Filenames are untrusted and shown as plain text. */
export function DocumentChips({ documents: { documents: allDocuments, uploading, error, remove }, messageId }: { documents: Documents; messageId?: string }) {
  const documents = allDocuments.filter(d => (d.messageId ?? undefined) === messageId);
  if (messageId) { uploading = undefined; error = undefined; }
  if (documents.length === 0 && uploading === undefined && !error) return null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-1.5 px-3 pt-3 text-sm">
      {documents.length > 0 && (
        <ul aria-label="Attached documents" className="flex flex-wrap gap-1.5">
          {documents.map((document) => (
            <li key={document.id} className="bg-muted text-foreground flex max-w-full min-w-0 flex-wrap items-center gap-1.5 rounded-md border py-0.5 pr-0.5 pl-2">
              <FileText className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={document.filename}>
                {document.filename}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">{pageLabel(document)}</span>
              <TooltipProvider delayDuration={400}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`Remove ${document.filename}`} onClick={() => void remove(document.id)}>
                      <X aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove attachment</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </li>
          ))}
        </ul>
      )}
      {uploading !== undefined && (
        <p role="status" className="text-muted-foreground flex min-w-0 items-center gap-2">
          <Spinner aria-hidden="true" /><span className="truncate">Reading {uploading}…</span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive wrap-anywhere">
          {error}
        </p>
      )}
      {documents.length > 0 && !messageId && <p className="text-muted-foreground text-xs">{NOT_READ}</p>}
    </div>
  );
}
