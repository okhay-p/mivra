import { ArtifactView, DocumentView, MemoryView } from "@mivra/protocol";
import type { AppType } from "@mivra/server";
import type { UIMessage } from "ai";
import { hc } from "hono/client";

/** API token the server (or Vite in dev) embeds in index.html. */
export const token = document.querySelector<HTMLMetaElement>('meta[name="mivra-token"]')?.content ?? "";

export const authHeaders = { Authorization: `Bearer ${token}` };

/** Typed client for the Mivra server API; types come from the server's route definitions. */
export const api = hc<AppType>(window.location.origin, { headers: authHeaders }).api;

/** Reads the server's `{ error }` body, falling back to the status text. */
export async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return `${res.status} ${res.statusText}`;
}

export type AttemptResult = { ok: true; view: ArtifactView } | { ok: false; error: string };

/** Submits an answer to a multiple-choice check; the server grades it and returns the updated view. */
export async function submitMultipleChoice(artifactId: string, optionIndex: number): Promise<AttemptResult> {
  try {
    const res = await api.artifacts[":id"].attempts.$post({ param: { id: artifactId }, json: { answer: { optionIndex } } });
    if (!res.ok) return { ok: false, error: await errorMessage(res) };
    const view = ArtifactView.safeParse(await res.json());
    return view.success ? { ok: true, view: view.data } : { ok: false, error: "The server sent a reply this page can't display." };
  } catch {
    return { ok: false, error: "Can't reach the Mivra server." };
  }
}

/** A session's stored messages, or the reason they couldn't be loaded. */
export async function loadMessages(
  sessionId: string,
): Promise<{ ok: true; messages: UIMessage[] } | { ok: false; error: string }> {
  try {
    const res = await api.sessions[":id"].messages.$get({ param: { id: sessionId } });
    if (!res.ok) return { ok: false, error: await errorMessage(res) };
    return { ok: true, messages: (await res.json()) as UIMessage[] };
  } catch {
    return { ok: false, error: "Can't reach the Mivra server." };
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs a request, reading a failure as the server's message. */
async function request<T>(send: () => Promise<Response>, read: (res: Response) => Promise<T> | T): Promise<Result<T>> {
  try {
    const res = await send();
    if (!res.ok) return { ok: false, error: await errorMessage(res) };
    return { ok: true, value: await read(res) };
  } catch {
    return { ok: false, error: "Can't reach the Mivra server." };
  }
}

export const listMemories = () =>
  request(
    () => api.memories.$get(),
    async (res) => MemoryView.array().parse(await res.json()),
  );

export const editMemory = (id: string, text: string) =>
  request(
    () => api.memories[":id"].$patch({ param: { id }, json: { text } }),
    async (res) => MemoryView.parse(await res.json()),
  );

export const deleteMemory = (id: string) =>
  request(
    () => api.memories[":id"].$delete({ param: { id } }),
    () => undefined,
  );

export const listDocuments = (sessionId: string) =>
  request(
    () => api.sessions[":id"].documents.$get({ param: { id: sessionId } }),
    async (res) => DocumentView.array().parse(await res.json()),
  );

/** Sent by hand: the typed client has no multipart body for this route, which the server reads as a stream. */
export const uploadDocument = (sessionId: string, file: File) => {
  const body = new FormData();
  body.append("file", file);
  return request(
    () => fetch(`/api/sessions/${sessionId}/documents`, { method: "POST", headers: authHeaders, body }),
    async (res) => DocumentView.parse(await res.json()),
  );
};

export const deleteDocument = (id: string) =>
  request(
    () => api.documents[":id"].$delete({ param: { id } }),
    () => undefined,
  );
