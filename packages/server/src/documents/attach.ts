import { Conflict, type DocumentRow, type SessionStore } from "../store/session-store.js";
import { chunkPages } from "./chunk.js";
import { extractInWorker, type Extract } from "./extract-in-worker.js";
import { DocumentError } from "./extract.js";
import { readUpload, sanitizeFilename, type UploadRequest } from "./upload.js";

/** Each extraction holds a file in memory and takes a thread. */
const MAX_CONCURRENT_UPLOADS = 2;
const MAX_DOCUMENTS_PER_SESSION = 20;
const TOO_MANY = `A session can have at most ${MAX_DOCUMENTS_PER_SESSION} documents.`;

export type AttachError = { kind: "not_found" | "bad_request" | "too_large" | "wrong_type" | "unreadable" | "limit" | "busy"; message: string };

const errorKinds: Record<DocumentError["code"], AttachError["kind"]> = {
  too_large: "too_large",
  wrong_type: "wrong_type",
  no_text: "unreadable",
  encrypted: "unreadable",
  corrupt: "unreadable",
  too_complex: "unreadable",
  timeout: "unreadable",
  failed: "bad_request",
};

export function createDocumentAttacher({ store, extract = extractInWorker, readTimeoutMs }: { store: SessionStore; extract?: Extract; readTimeoutMs?: number }) {
  let uploading = 0;
  return async (sessionId: string, upload: UploadRequest, signal?: AbortSignal): Promise<{ ok: true; document: DocumentRow } | { ok: false; error: AttachError }> => {
    const refuse = (kind: AttachError["kind"], message: string) => {
      void upload.body?.cancel().catch(() => {});
      return { ok: false as const, error: { kind, message } };
    };
    if (!store.findSession(sessionId)) return refuse("not_found", "Session not found");
    // Saves reading a file that can't be kept. createDocument has the final say, once this upload is ready.
    if (store.listDocuments(sessionId).length >= MAX_DOCUMENTS_PER_SESSION) return refuse("limit", TOO_MANY);
    if (uploading >= MAX_CONCURRENT_UPLOADS) return refuse("busy", "Other files are still uploading. Try again in a moment.");

    uploading++;
    try {
      const { filename, bytes } = await readUpload(upload, { signal, ...(readTimeoutMs ? { timeoutMs: readTimeoutMs } : {}) });
      const extracted = await extract(bytes, { signal });
      const chunks = chunkPages(extracted.pages);
      const document = store.createDocument(
        {
          sessionId,
          filename: sanitizeFilename(filename),
          kind: extracted.kind,
          byteSize: bytes.byteLength,
          textChars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
          pageCount: extracted.pageCount,
          pagesWithText: extracted.pages.length,
        },
        chunks,
        MAX_DOCUMENTS_PER_SESSION,
      );
      return { ok: true, document };
    } catch (error) {
      if (error instanceof Conflict) return { ok: false, error: { kind: "limit", message: TOO_MANY } };
      if (error instanceof DocumentError) return { ok: false, error: { kind: errorKinds[error.code], message: error.message } };
      throw error;
    } finally {
      uploading--;
    }
  };
}

export type AttachDocument = ReturnType<typeof createDocumentAttacher>;
