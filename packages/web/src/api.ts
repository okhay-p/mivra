import { ArtifactView, CourseLessonsView, CourseView, DocumentView, LessonView, MAX_VAULT_BYTES, MemoryView, VaultImportResult, VaultImportView, type PlacementAnswer, type VaultFile } from "@mivra/protocol";
import type { AppType } from "@mivra/server";
import type { UIMessage } from "ai";
import { hc, type InferResponseType } from "hono/client";

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
export const submitMultipleChoice = (artifactId: string, optionIndex: number) => submitAnswer(artifactId, { optionIndex });

/** Submits an answer to a placement question: an option, Not sure, or Skip. */
export const submitPlacement = (artifactId: string, answer: PlacementAnswer) => submitAnswer(artifactId, answer);

async function submitAnswer(artifactId: string, answer: unknown): Promise<AttemptResult> {
  try {
    const res = await api.artifacts[":id"].attempts.$post({ param: { id: artifactId }, json: { answer } });
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

/** A chat session as the sidebar lists it. */
export interface Session {
  id: string;
  title: string;
  updatedAt: string;
  courseId: string | null;
  /** A course's subject icon by Lucide name; null for free chat or before the tutor names the course. */
  icon?: string | null;
}

/** Creates an empty session; the app does this only once a draft is sent or given a file. */
export const createSession = () => request(() => api.sessions.$post({ json: {} }), async (res) => (await res.json()) as Session);

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

export const listImports = () =>
  request(
    () => api.imports.$get(),
    async (res) => VaultImportView.array().parse(await res.json()),
  );

export const deleteImport = (id: string) =>
  request(
    () => api.imports[":id"].$delete({ param: { id } }),
    () => undefined,
  );

/** A new import with this name, or a re-import of an existing one. */
export type ImportTarget = { name: string } | { importId: string };

const tooLargeImport = `These notes come to more than ${MAX_VAULT_BYTES / (1024 * 1024)} MB, more than one import can take.`;

/** Sent by hand so the body's size can be checked before it's sent: the server refuses one over the limit unread. */
export const importVaultFiles = (target: ImportTarget, files: VaultFile[]) => {
  const body = JSON.stringify("importId" in target ? { files } : { name: target.name, files });
  if (new Blob([body]).size > MAX_VAULT_BYTES) return Promise.resolve({ ok: false as const, error: tooLargeImport });
  return request(
    () =>
      "importId" in target
        ? fetch(`/api/imports/${encodeURIComponent(target.importId)}/files`, { method: "PUT", headers: { ...authHeaders, "content-type": "application/json" }, body })
        : fetch("/api/imports", { method: "POST", headers: { ...authHeaders, "content-type": "application/json" }, body }),
    async (res) => VaultImportResult.parse(await res.json()),
  );
};

/** Sent by hand: the typed client has no multipart body for these routes, which the server reads as a stream. */
export const importVaultZip = (target: ImportTarget, file: File) => {
  if (file.size > MAX_VAULT_BYTES) return Promise.resolve({ ok: false as const, error: `This zip is over the ${MAX_VAULT_BYTES / (1024 * 1024)} MB limit.` });
  const body = new FormData();
  if ("name" in target) body.append("name", target.name);
  body.append("file", file);
  return request(
    () =>
      "importId" in target
        ? fetch(`/api/imports/${encodeURIComponent(target.importId)}/zip`, { method: "PUT", headers: authHeaders, body })
        : fetch("/api/imports/zip", { method: "POST", headers: authHeaders, body }),
    async (res) => VaultImportResult.parse(await res.json()),
  );
};

/** Starts a course for a goal; the server creates its session too. */
export const startCourse = (goal: string) =>
  request(
    () => api.courses.$post({ json: { goal } }),
    async (res) => {
      const body = (await res.json()) as { course: unknown; session: { id: string; title: string; updatedAt: string; courseId: string | null } };
      return { course: CourseView.parse(body.course), session: body.session };
    },
  );

export const getCourse = (sessionId: string) =>
  request(
    () => api.sessions[":id"].course.$get({ param: { id: sessionId } }),
    async (res) => CourseView.parse(await res.json()),
  );

export const listCourseLessons = (courseId: string) =>
  request(
    () => api.courses[":id"].lessons.$get({ param: { id: courseId } }),
    async (res) => CourseLessonsView.parse(await res.json()),
  );

const readLesson = async (res: Response) => {
  const body = (await res.json()) as { lesson: unknown; revision: string };
  return { lesson: LessonView.parse(body.lesson), revision: body.revision };
};

export const startLesson = (courseId: string, topicId: string) =>
  request(() => api.courses[":id"].lessons.$post({ param: { id: courseId }, json: { topicId } }), readLesson);

/** The lesson; with `after`, waits on the server for the next change. */
export const getLesson = (id: string, after?: string, signal?: AbortSignal) =>
  request(() => api.lessons[":id"].$get({ param: { id }, query: after ? { after } : {} }, { init: { signal } }), readLesson);

export const finishLesson = (id: string) => request(() => api.lessons[":id"].finish.$post({ param: { id } }), readLesson);

export const retryLesson = (id: string) => request(() => api.lessons[":id"].retry.$post({ param: { id } }), readLesson);

/** Keeps one of the tutor's answers as a new section of the lesson (a Change). */
export const addToLesson = (lessonId: string, body: { messageId: string; afterSectionId: string | null; title: string }) =>
  request(() => api.lessons[":id"].sections.$post({ param: { id: lessonId }, json: body }), readLesson);

/** Undoes Mivra's automatic change to the syllabus. */
export const undoSyllabusChange = (courseId: string, version: number) =>
  request(
    () => api.courses[":id"].syllabus.undo.$post({ param: { id: courseId }, json: { version } }),
    async (res) => CourseView.parse(await res.json()),
  );

/** The model picker's contents (ADR-012). */
export type ModelPickerView = InferResponseType<typeof api.models.$get, 200>;
export type CatalogModel = ModelPickerView["models"][number];
export type ModelSelection = ModelPickerView["current"];
export type ReasoningEffort = NonNullable<ModelSelection["effort"]>;

export const getModelPicker = () => request(() => api.models.$get(), async (res) => (await res.json()) as ModelPickerView);

export const selectModel = (selection: ModelSelection) =>
  request(() => api.settings.model.$put({ json: selection }), async (res) => (await res.json()) as ModelSelection);

export const setPinnedModels = (models: string[]) =>
  request(() => api.settings["pinned-models"].$put({ json: { models } }), async (res) => ((await res.json()) as { pinned: string[] }).pinned);

/** A background task's model (ADR-012, option D): its override, or null to follow the main model. */
export type ModelTaskView = InferResponseType<typeof api.settings.tasks.$get, 200>["tasks"][number];
export type ModelTaskId = ModelTaskView["id"];

export const getModelTasks = () => request(() => api.settings.tasks.$get(), async (res) => ((await res.json()) as { tasks: ModelTaskView[] }).tasks);

export const setModelTask = (task: ModelTaskId, selection: ModelSelection) =>
  request(() => api.settings.tasks[":task"].$put({ param: { task }, json: selection }), async (res) => (await res.json()) as ModelTaskView);

/** Back to the main model, followed from then on. */
export const resetModelTask = (task: ModelTaskId) =>
  request(() => api.settings.tasks[":task"].$delete({ param: { task } }), async (res) => (await res.json()) as ModelTaskView);

/** Asks the app to open Settings, from anywhere (a failed lesson's "Lesson model settings", say). */
export const OPEN_SETTINGS = "mivra:open-settings";

/** Which providers have an API key, and whether this client may change them (ADR-013). Keys never come back. */
export type ProviderKeysView = InferResponseType<typeof api.settings.providers.$get, 200>;
export type ProviderKey = ProviderKeysView["providers"][number];
export type ProviderId = ProviderKey["id"];

/** Fired after a key is saved or removed, so the model picker reloads the providers it lists. */
export const PROVIDERS_CHANGED = "mivra:providers-changed";

const readProviderKeys = async (res: Response) => {
  window.dispatchEvent(new Event(PROVIDERS_CHANGED));
  return (await res.json()) as ProviderKeysView;
};

export const getProviderKeys = () => request(() => api.settings.providers.$get(), async (res) => (await res.json()) as ProviderKeysView);

export const saveProviderKey = (id: ProviderId, key: string) =>
  request(() => api.settings.providers[":id"].$put({ param: { id }, json: { key } }), readProviderKeys);

export const removeProviderKey = (id: ProviderId) => request(() => api.settings.providers[":id"].$delete({ param: { id } }), readProviderKeys);

/** Sign in with ChatGPT (ADR-015). Tokens never reach the browser; this is only whether it's signed in. */
export type ChatGptSignIn = NonNullable<ProviderKeysView["chatgpt"]>;

/** Starts a sign-in; the server waits on 127.0.0.1 for the browser to come back from the returned URL. */
export const startChatGptSignIn = (newAccount = false) =>
  request(() => api.settings.chatgpt["sign-in"].$post({ json: { newAccount } }), async (res) => (await res.json()) as { url: string });

/** Finishes the sign-in from the address the browser ended on, when it couldn't reach the server. */
export const completeChatGptSignIn = (address: string) =>
  request(() => api.settings.chatgpt["sign-in"].complete.$post({ json: { address } }), readProviderKeys);

export const cancelChatGptSignIn = () => request(() => api.settings.chatgpt["sign-in"].$delete(), readProviderKeys);

export const signOutChatGpt = () => request(() => api.settings.chatgpt.$delete(), readProviderKeys);

/** Records that the one-time ChatGPT plan welcome was shown. */
export const markChatGptWelcomed = () => request(() => api.settings.chatgpt.welcomed.$post(), async (res) => (await res.json()) as ProviderKeysView);

export const checkChatGpt = () =>
  request(() => api.settings.chatgpt.check.$post(), async (res) => (await res.json()) as { ok: boolean; message?: string });

export const checkProviderKey = (id: ProviderId) =>
  request(
    () => api.settings.providers[":id"].check.$post({ param: { id } }),
    async (res) => (await res.json()) as { ok: boolean; reason?: "rejected" | "unreachable"; message?: string },
  );

/** Gives a session or course the learner's own title, which automatic titling then leaves alone. */
export const renameSession = (id: string, title: string) =>
  request(() => api.sessions[":id"].$patch({ param: { id }, json: { title } }), async (res) => (await res.json()) as Session);

/** Deletes a session and all that belongs only to it; for a course, its lessons and their chats too. */
export const deleteSession = (id: string) => request(() => api.sessions[":id"].$delete({ param: { id } }), () => undefined);

/** A custom OpenAI-compatible provider (issue #69): its URL, key status, models and their test results. Never its key. */
export type CustomProvider = ProviderKeysView["custom"][number];
export type CustomModelEntry = { id: string; contextLength?: number | null; maxOutputTokens?: number | null };

export const createCustomProvider = (body: { name: string; baseUrl?: string | null; key?: string; models?: CustomModelEntry[] }) =>
  request(() => api.settings.providers.custom.$post({ json: body }), readProviderKeys);

export const updateCustomProvider = (id: string, body: { name?: string; baseUrl?: string | null; key?: string | null; models?: CustomModelEntry[] }) =>
  request(() => api.settings.providers.custom[":id"].$put({ param: { id }, json: body }), readProviderKeys);

export const removeCustomProvider = (id: string) => request(() => api.settings.providers.custom[":id"].$delete({ param: { id } }), readProviderKeys);

/** Loads the provider's model list from <base URL>/models. */
export const refreshCustomModels = (id: string) => request(() => api.settings.providers.custom[":id"].refresh.$post({ param: { id } }), readProviderKeys);

/** Tests one model for streamed tool calling; it may spend a few tokens. Aborting the signal cancels it. */
export const testCustomModel = (id: string, model: string, signal?: AbortSignal) =>
  request(
    () => api.settings.providers.custom[":id"].test.$post({ param: { id }, json: { model } }, { init: { signal } }),
    async (res) => {
      window.dispatchEvent(new Event(PROVIDERS_CHANGED));
      return (await res.json()) as { result: { ok: boolean; reason?: string; message: string }; providers: ProviderKeysView };
    },
  );
