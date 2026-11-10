import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { LanguageModel } from "ai";
import {
  AddToLesson,
  ArtifactView,
  CourseLessonsView,
  CourseIcon,
  CourseView,
  DocumentView,
  LessonView,
  MAX_VAULT_BYTES,
  MemoryEdit,
  MemoryView,
  NoteGraph,
  NoteView,
  StartCourse,
  VaultImportInput,
  VaultImportResult,
  VaultImportView,
  VaultSnapshotInput,
} from "@mivra/protocol";
import { bodyLimit } from "hono/body-limit";
import { ChatGptError, CHATGPT_API } from "./chatgpt/oauth.js";
import type { ChatGptSession } from "./chatgpt/session.js";
import { ApiKey, memoryCredentials, providerIds, type CredentialStore, type ProviderId } from "./credentials.js";
import type { Db } from "./db/client.js";
import { createDocumentAttacher, type AttachError } from "./documents/attach.js";
import { reasoningEfforts, type ModelSelection } from "./model.js";
import { staticCatalog, type ModelCatalog } from "./models/catalog.js";
import { CUSTOM_PREFIX, CustomProviderError, CustomProviderNotFound, createCustomProviders } from "./models/custom-providers.js";
import type { KeyCheck } from "./models/key-check.js";
import { MAX_PINNED, ModelId, SelectionInput, TaskModelError, createModelSettings, modelTasks, type ModelTask } from "./models/selection.js";
import type { Extract } from "./documents/extract-in-child.js";
import { coreCourse } from "./plugins/core-course.js";
import { coreLearning } from "./plugins/core-learning.js";
import { coreMemory } from "./plugins/core-memory.js";
import { presentMessages } from "./runtime/artifacts.js";
import { submitAttempt } from "./runtime/attempts.js";
import { createCapabilityRegistry, type Plugin } from "./runtime/capabilities.js";
import { courseLessons, createLessonGenerator, lessonRevision, lessonView, reconcileCompletion } from "./runtime/lessons.js";
import { createTurnRunner, type TurnError } from "./runtime/turn-runner.js";
import { hostGuard, isLoopbackPeer, tokenGuard, type SecurityConfig } from "./security.js";
import { importVault, importView, resolveGraph } from "./notes/vault-import.js";
import { createZipImporter, type UnzipVault, type ZipImportError } from "./notes/vault-zip-import.js";
import { createLessonStore, type LessonStore } from "./store/lesson-store.js";
import { createNoteStore, type NoteRow } from "./store/note-store.js";
import { createSettingsStore } from "./store/settings-store.js";
import { createSessionStore, type CourseRow, type DocumentRow, type MemoryRow, type SessionRow, type SessionStore } from "./store/session-store.js";
import { createUsageStore } from "./store/usage-store.js";
import { BUILT_IN_PROVIDERS, billingOf, providerOf, summarise, usageKindList } from "./usage/accounting.js";
import { CustomPrice, createCustomPrices, createUsageTracker, type ModelFacts } from "./usage/tracker.js";

export interface AppDeps {
  db: Db;
  /** Resolves the selected model. Tests may ignore the selection and return a mock. */
  model: (selection: ModelSelection) => LanguageModel;
  /** The model picker (ADR-012). Without a catalog, the default model is the only choice; `defaults` replaces the built-in one. */
  models?: { defaults?: ModelSelection | (() => ModelSelection); catalog?: ModelCatalog; suggested?: string[] };
  security: SecurityConfig;
  /**
   * Provider API keys (ADR-013). `check` asks the provider whether it accepts a key; `isLocal` says whether a
   * request may change keys, by default when it comes from a loopback address. Defaults to no keys in memory.
   */
  providers?: {
    credentials: CredentialStore;
    check?: (provider: ProviderId, key: string) => Promise<KeyCheck>;
    isLocal?: (c: Context) => boolean;
    /** The learner's ChatGPT sign-in (ADR-015). Without it, the ChatGPT routes answer 404. */
    chatgpt?: ChatGptSession;
    /** Override fetch for the ChatGPT check, for tests. */
    fetch?: typeof fetch;
    /**
     * Custom OpenAI-compatible providers (issue #69): `env` reads the variables that may set a provider's URL and key
     * (`MIVRA_PROVIDER_<ID>_BASE_URL`, `_API_KEY`); `fetch` is for their lists, tests and model calls.
     */
    custom?: { env?: (name: string) => string | undefined; fetch?: typeof fetch };
  };
  /** Defaults to the first-party core-learning, core-memory and core-course plugins. */
  plugins?: Plugin[];
  /** Defaults to extracting on a worker thread. */
  extractDocument?: Extract;
  /** Defaults to unpacking in the same kind of subprocess. */
  unzipVault?: UnzipVault;
}

const Session = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** The course this session teaches, or null for free chat. */
    courseId: z.string().nullable(),
    /** The course's subject icon, by Lucide name; null for free chat or a course the tutor hasn't titled yet. */
    icon: CourseIcon.nullable(),
  })
  .openapi("Session");

// Message parts are validated by the AI SDK (validateUIMessages); the schema here only documents the shape.
const Message = z
  .object({
    id: z.string(),
    role: z.enum(["system", "user", "assistant"]),
    parts: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("UIMessage");

const Selection = z.object({ model: z.string(), effort: z.enum(reasoningEfforts).nullable() }).openapi("ModelSelection");
const CatalogModel = z
  .object({
    id: z.string(),
    name: z.string(),
    contextLength: z.number().nullable(),
    price: z.object({ input: z.number(), output: z.number() }).nullable().openapi({ description: "US dollars per million tokens" }),
    reasoning: z.object({ efforts: z.array(z.enum(reasoningEfforts)), defaultEffort: z.enum(reasoningEfforts).nullable() }).nullable(),
    verification: z
      .enum(["unverified", "verified", "failed"])
      .optional()
      .openapi({ description: "A custom provider's model only: whether its last compatibility test, for the URL and key in use, passed" }),
  })
  .openapi("CatalogModel");
const ModelPicker = z
  .object({
    current: Selection,
    recent: z.array(z.string()),
    pinned: z.array(z.string()),
    suggested: z.array(z.string()),
    models: z.array(CatalogModel),
    catalog: z.enum(["fresh", "stale", "unavailable"]),
    providers: z
      .array(z.object({ id: z.string(), name: z.string(), removed: z.boolean() }))
      .openapi({ description: "Custom providers' names by the prefix of their model ids (`custom:<id>`), removed ones included so old replies stay labelled" }),
    unavailable: z.string().nullable().openapi({ description: "Why the current model can't run any more (its custom provider was removed, say); choose another" }),
  })
  .openapi("ModelPicker");

const SessionParams = z.object({ id: z.string() });
const ErrorBody = z.object({ error: z.string() });
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorBody } },
});

const health = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: { description: "Server is up", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
  },
});

const listSessions = createRoute({
  method: "get",
  path: "/sessions",
  responses: {
    200: { description: "Sessions, most recent first", content: { "application/json": { schema: z.array(Session) } } },
  },
});

const createSession = createRoute({
  method: "post",
  path: "/sessions",
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: z.object({ title: z.string().min(1).optional() }) } },
    },
  },
  responses: {
    201: { description: "Created session", content: { "application/json": { schema: Session } } },
  },
});

const renameSession = createRoute({
  method: "patch",
  path: "/sessions/{id}",
  description: "Rename a session or course. A title the learner sets is never replaced by automatic titling.",
  request: {
    params: SessionParams,
    body: { required: true, content: { "application/json": { schema: z.object({ title: z.string().trim().min(1).max(120) }) } } },
  },
  responses: {
    200: { description: "Renamed session", content: { "application/json": { schema: Session } } },
    400: errorResponse("The title is empty or longer than 120 characters"),
    404: errorResponse("Unknown session"),
  },
});

const deleteSession = createRoute({
  method: "delete",
  path: "/sessions/{id}",
  description:
    "Delete a session with its messages, artifacts and documents; for a course also its syllabus, lessons and each lesson's own chat. A reply in progress is stopped first. Memories are kept, no longer linked to the session.",
  request: { params: SessionParams },
  responses: {
    204: { description: "Deleted" },
    404: errorResponse("Unknown session"),
    409: errorResponse("A lesson's chat is deleted with its course"),
  },
});

const startCourse = createRoute({
  method: "post",
  path: "/courses",
  description:
    "Start a course for one learning goal (ADR-011). Creates the course and a session for it; the placement interview runs in that session's chat, starting with the learner's first message.",
  request: { body: { content: { "application/json": { schema: StartCourse } } } },
  responses: {
    201: {
      description: "The course and its session",
      content: { "application/json": { schema: z.object({ course: CourseView, session: Session }) } },
    },
    400: errorResponse("Invalid goal"),
  },
});

const getCourse = createRoute({
  method: "get",
  path: "/sessions/{id}/course",
  request: { params: SessionParams },
  responses: {
    200: { description: "The session's course with its latest syllabus", content: { "application/json": { schema: CourseView } } },
    404: errorResponse("Unknown session, or the session isn't a course"),
  },
});

const CourseParams = z.object({ id: z.string() });
const LessonParams = z.object({ id: z.string() });
const LessonResponse = z.object({ lesson: LessonView, revision: z.string() });
const lessonResponse = (description: string) => ({ description, content: { "application/json": { schema: LessonResponse } } });

const listCourseLessons = createRoute({
  method: "get",
  path: "/courses/{id}/lessons",
  request: { params: CourseParams },
  responses: {
    200: { description: "The syllabus topics with their lessons", content: { "application/json": { schema: CourseLessonsView } } },
    404: errorResponse("Unknown course"),
  },
});

const startLesson = createRoute({
  method: "post",
  path: "/courses/{id}/lessons",
  description:
    "Start the lesson for the next topic (ADR-011). Lessons are written just in time: only once every earlier lesson is finished. Generation runs in the background; follow it with GET /lessons/{id}?after=.",
  request: { params: CourseParams, body: { content: { "application/json": { schema: z.object({ topicId: z.string().min(1) }) } } } },
  responses: {
    201: lessonResponse("The new lesson, or the topic's existing one"),
    404: errorResponse("Unknown course or topic"),
    409: errorResponse("The course has no syllabus yet, or an earlier lesson isn't finished"),
  },
});

const getLesson = createRoute({
  method: "get",
  path: "/lessons/{id}",
  description: "The lesson. With `after` set to a revision the client already has, waits up to 20 s for the next change.",
  request: { params: LessonParams, query: z.object({ after: z.string().max(100).optional() }) },
  responses: { 200: lessonResponse("The lesson and its revision"), 404: errorResponse("Unknown lesson") },
});

const finishLesson = createRoute({
  method: "post",
  path: "/lessons/{id}/finish",
  description: "Finish a lesson the learner has read to the end. Every section must be written and every check answered; scores don't matter. A finished lesson is frozen.",
  request: { params: LessonParams },
  responses: { 200: lessonResponse("The finished lesson"), 404: errorResponse("Unknown lesson"), 409: errorResponse("Not finished being written, or a check is unanswered") },
});

const retryLesson = createRoute({
  method: "post",
  path: "/lessons/{id}/retry",
  description: "Resume a lesson whose generation stopped part-way. Sections already written are kept.",
  request: { params: LessonParams },
  responses: { 202: lessonResponse("The lesson, generating again"), 404: errorResponse("Unknown lesson"), 409: errorResponse("The lesson didn't fail") },
});

const addToLesson = createRoute({
  method: "post",
  path: "/lessons/{id}/sections",
  description:
    "Add to lesson: keep one of the tutor's answers as a new prose section of the lesson (ADR-011). Counts as a Change: it makes a new version and the section is highlighted. A finished lesson can't change.",
  request: { params: LessonParams, body: { content: { "application/json": { schema: AddToLesson } } } },
  responses: {
    201: lessonResponse("The lesson's new version"),
    400: errorResponse("Not one of the tutor's replies in this course, or it has no text"),
    404: errorResponse("Unknown lesson or section"),
    409: errorResponse("The lesson is finished or still being written"),
  },
});

const undoSyllabusChange = createRoute({
  method: "post",
  path: "/courses/{id}/syllabus/undo",
  description: "Undo Mivra's automatic change to the syllabus (ADR-011): a new version with the topics as they were. Only the latest version, and only before any topic it added has a lesson.",
  request: { params: CourseParams, body: { content: { "application/json": { schema: z.object({ version: z.number().int().positive() }) } } } },
  responses: {
    200: { description: "The course with the restored syllabus", content: { "application/json": { schema: CourseView } } },
    404: errorResponse("Unknown course"),
    409: errorResponse("Not the latest version, not an automatic change, or one of its lessons has started"),
  },
});

const listModels = createRoute({
  method: "get",
  path: "/models",
  description:
    "The model picker (ADR-012): the current selection, the learner's recent and pinned models, suggestions, and every model that can call tools. `catalog` says whether the list is fresh, a stale copy, or couldn't be loaded.",
  responses: { 200: { description: "The picker's contents", content: { "application/json": { schema: ModelPicker } } } },
});

const selectModel = createRoute({
  method: "put",
  path: "/settings/model",
  description: "Choose the main model and reasoning effort for every later run: chat, syllabus, and lessons unless their task is overridden (`/settings/tasks`). A null effort uses the model's default. A run already streaming keeps its model.",
  request: { body: { content: { "application/json": { schema: SelectionInput } } } },
  responses: {
    200: { description: "The saved selection", content: { "application/json": { schema: Selection } } },
    400: errorResponse("Unknown model, or an effort it doesn't support"),
    503: errorResponse("The model list couldn't be loaded"),
  },
});

const ModelTaskView = z
  .object({
    id: z.enum(modelTasks),
    override: Selection.nullable().openapi({ description: "The task's own model, or null to use the main model (the picker's), whatever it is when a job starts" }),
    effective: Selection.openapi({ description: "The model and effort a job of this task starting now would use" }),
    unavailable: z.string().nullable().openapi({ description: "Why the override can't run now; jobs fail with this until another model is chosen or the override is reset" }),
  })
  .openapi("ModelTask");
const TaskParams = z.object({ task: z.enum(modelTasks) });

const listModelTasks = createRoute({
  method: "get",
  path: "/settings/tasks",
  description: "Background tasks' models (ADR-012, option D): each uses the main model unless overridden. Only lesson generation can be overridden; chat and syllabus generation always use the main model.",
  responses: { 200: { description: "Each task's model", content: { "application/json": { schema: z.object({ tasks: z.array(ModelTaskView) }) } } } },
});

const setModelTask = createRoute({
  method: "put",
  path: "/settings/tasks/{task}",
  description: "Give a task its own model and effort, checked like the main selection. Applies from the task's next job; a job already running keeps its model.",
  request: { params: TaskParams, body: { content: { "application/json": { schema: SelectionInput } } } },
  responses: {
    200: { description: "The task's model", content: { "application/json": { schema: ModelTaskView } } },
    400: errorResponse("Unknown model, or an effort it doesn't support"),
    503: errorResponse("The model list couldn't be loaded"),
  },
});

const resetModelTask = createRoute({
  method: "delete",
  path: "/settings/tasks/{task}",
  description: "Remove a task's override, so its jobs use the main model again and follow later changes to it.",
  request: { params: TaskParams },
  responses: { 200: { description: "The task's model", content: { "application/json": { schema: ModelTaskView } } } },
});

const setPinnedModels = createRoute({
  method: "put",
  path: "/settings/pinned-models",
  description: "Replace the models the learner pinned in the picker, in order.",
  request: { body: { content: { "application/json": { schema: z.object({ models: z.array(ModelId).max(MAX_PINNED) }) } } } },
  responses: { 200: { description: "The pinned models", content: { "application/json": { schema: z.object({ pinned: z.array(z.string()) }) } } } },
});

const ProviderKey = z
  .object({
    id: z.enum(providerIds),
    label: z.string(),
    source: z.enum(["env", "saved"]).nullable().openapi({ description: "env: set by an environment variable, which Mivra can't change" }),
    hint: z.string().nullable().openapi({ description: "The key's last four characters" }),
  })
  .openapi("ProviderKey");
const ChatGptView = z
  .object({
    signedIn: z.boolean(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    pending: z.boolean().openapi({ description: "A sign-in is waiting for the browser to come back" }),
    previous: z.string().nullable().openapi({ description: "The account a new sign-in reuses, when signed out" }),
    notice: z.string().nullable().openapi({ description: "Why the last sign-in failed, or why Mivra signed the learner out" }),
    welcome: z.boolean().openapi({ description: "Signed in, and the one-time welcome dialog hasn't been shown" }),
  })
  .openapi("ChatGptSignIn");
const Verification = z.object({
  status: z.enum(["unverified", "verified", "failed"]),
  message: z.string().nullable(),
  at: z.string().datetime().nullable(),
});
const CustomProvider = z
  .object({
    id: z.string().openapi({ description: "Stable: renaming the provider doesn't change it, and its models are custom:<id>/<model id>" }),
    name: z.string(),
    baseUrl: z.object({
      value: z.string().nullable(),
      source: z.enum(["saved", "env"]).nullable(),
      env: z.string().nullable().openapi({ description: "The URL its environment variable sets, which a saved URL overrides" }),
      error: z.string().nullable(),
    }),
    key: z.object({ source: z.enum(["env", "saved"]).nullable(), hint: z.string().nullable() }),
    envNames: z.object({ baseUrl: z.string(), key: z.string() }),
    models: z.array(z.object({
      id: z.string(),
      modelId: z.string(),
      contextLength: z.number().nullable(),
      maxOutputTokens: z.number().nullable(),
      verification: Verification,
    })),
    discovery: z.object({
      state: z.enum(["none", "fresh", "stale", "failed"]),
      ids: z.array(z.string()),
      error: z.string().nullable(),
      fetchedAt: z.string().datetime().nullable(),
    }).openapi({ description: "The provider's own model list from <base URL>/models, separate from any compatibility test" }),
  })
  .openapi("CustomProvider");
const ProviderKeys = z
  .object({
    providers: z.array(ProviderKey),
    custom: z.array(CustomProvider).openapi({ description: "Custom OpenAI-compatible providers (issue #69). Keys are never returned" }),
    chatgpt: ChatGptView.nullable().openapi({ description: "Sign in with ChatGPT (ADR-015); null when this server doesn't offer it" }),
    canEdit: z.boolean().openapi({ description: "Whether this client may change keys: only from the server's own machine" }),
  })
  .openapi("ProviderKeys");
const ProviderParams = z.object({ id: z.enum(providerIds) });

const listProviderKeys = createRoute({
  method: "get",
  path: "/settings/providers",
  description: "Which providers have an API key and where it comes from (ADR-013). Keys themselves are never returned.",
  responses: { 200: { description: "Each provider's key status", content: { "application/json": { schema: ProviderKeys } } } },
});

const setProviderKey = createRoute({
  method: "put",
  path: "/settings/providers/{id}",
  description: "Save a provider's API key. Only accepted from the server's own machine. It applies from the next run.",
  request: { params: ProviderParams, body: { content: { "application/json": { schema: z.object({ key: z.string() }) } } } },
  responses: {
    200: { description: "Each provider's key status", content: { "application/json": { schema: ProviderKeys } } },
    400: errorResponse("Not a valid API key"),
    403: errorResponse("Keys can only be changed on the server's own machine"),
    409: errorResponse("The key comes from an environment variable"),
  },
});

const removeProviderKey = createRoute({
  method: "delete",
  path: "/settings/providers/{id}",
  description: "Remove a saved API key. Only accepted from the server's own machine.",
  request: { params: ProviderParams },
  responses: {
    200: { description: "Each provider's key status", content: { "application/json": { schema: ProviderKeys } } },
    403: errorResponse("Keys can only be changed on the server's own machine"),
    404: errorResponse("No saved key"),
    409: errorResponse("The key comes from an environment variable"),
  },
});

const checkProviderKeyRoute = createRoute({
  method: "post",
  path: "/settings/providers/{id}/check",
  description: "Ask the provider whether it accepts the key in use, with a request that spends no tokens.",
  request: { params: ProviderParams },
  responses: {
    200: {
      description: "Whether the provider accepted the key",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), reason: z.enum(["rejected", "unreachable"]).optional(), message: z.string().optional() }) } },
    },
    404: errorResponse("No key set for this provider"),
  },
});

const providersResponse = { description: "Each provider's status", content: { "application/json": { schema: ProviderKeys } } };

const CustomModelBody = z.object({
  id: z.string().max(1000),
  contextLength: z.number().nullable().optional(),
  maxOutputTokens: z.number().nullable().optional(),
});
const CustomParams = z.object({ id: z.string().max(100) });

const createCustomProvider = createRoute({
  method: "post",
  path: "/settings/providers/custom",
  description:
    "Add an OpenAI-compatible provider (Chat Completions). Only accepted from the server's own machine. The key goes in the credential store, never the database; leave it out for a local server that needs none.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().max(1000),
            baseUrl: z.string().max(2000).nullable().optional(),
            key: z.string().max(1000).optional(),
            models: z.array(CustomModelBody).max(1000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: providersResponse,
    400: errorResponse("A name, URL, key or model id isn't valid"),
    403: errorResponse("Providers can only be changed on the server's own machine"),
  },
});

const updateCustomProvider = createRoute({
  method: "put",
  path: "/settings/providers/custom/{id}",
  description:
    "Change a custom provider. Only accepted from the server's own machine. `baseUrl: null` goes back to the environment's URL and `key: null` removes the saved key. A new URL or key clears its model list and test results. Applies from the next run.",
  request: {
    params: CustomParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().max(1000).optional(),
            baseUrl: z.string().max(2000).nullable().optional(),
            key: z.string().max(1000).nullable().optional(),
            models: z.array(CustomModelBody).max(1000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: providersResponse,
    400: errorResponse("A name, URL, key or model id isn't valid"),
    403: errorResponse("Providers can only be changed on the server's own machine"),
    404: errorResponse("No such provider"),
  },
});

const removeCustomProvider = createRoute({
  method: "delete",
  path: "/settings/providers/custom/{id}",
  description: "Remove a custom provider and its saved key. Only accepted from the server's own machine. Replies it wrote keep naming it.",
  request: { params: CustomParams },
  responses: {
    200: providersResponse,
    403: errorResponse("Providers can only be changed on the server's own machine"),
    404: errorResponse("No such provider"),
  },
});

const refreshCustomModels = createRoute({
  method: "post",
  path: "/settings/providers/custom/{id}/refresh",
  description: "Load the provider's model list from <base URL>/models, with only its own key. A failure is reported in `discovery` and keeps the last good list.",
  request: { params: CustomParams },
  responses: { 200: providersResponse, 400: errorResponse("No base URL set"), 404: errorResponse("No such provider") },
});

const testCustomModel = createRoute({
  method: "post",
  path: "/settings/providers/custom/{id}/test",
  description:
    "Check that a configured model streams, calls a tool and continues after the tool's result, as Mivra needs. It spends a few tokens. The result applies to the URL and key in use now.",
  request: { params: CustomParams, body: { content: { "application/json": { schema: z.object({ model: z.string().max(1000) }) } } } },
  responses: {
    200: {
      description: "The test's outcome, and every provider's status",
      content: {
        "application/json": {
          schema: z.object({
            result: z.object({ ok: z.boolean(), reason: z.string().optional(), message: z.string() }),
            providers: ProviderKeys,
          }),
        },
      },
    },
    400: errorResponse("Not one of the provider's models, or no base URL"),
    404: errorResponse("No such provider"),
  },
});
const Price = z
  .object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() })
  .openapi("ModelPrice", { description: "US dollars per million tokens; cached input rates only when listed" });
const Totals = {
  calls: z.number(),
  incomplete: z.number().openapi({ description: "Calls that failed or were cancelled; what they reported still counts" }),
  unreported: z.number().openapi({ description: "Calls that didn't report their input or output tokens: unknown, not zero" }),
  input: z.number().nullable().openapi({ description: "Input tokens, cached ones included; null when no call reported them" }),
  cacheRead: z.number().nullable().openapi({ description: "Of the input, read from the provider's cache" }),
  cacheWrite: z.number().nullable().openapi({ description: "Of the input, written to the provider's cache" }),
  output: z.number().nullable().openapi({ description: "Output tokens, reasoning included" }),
  reasoning: z.number().nullable().openapi({ description: "Of the output, reasoning" }),
  total: z.number().nullable().openapi({ description: "Input plus output, over calls that reported both" }),
  reportedCost: z.number().nullable().openapi({ description: "API spending the provider reported, in US dollars" }),
  estimatedCost: z.number().nullable().openapi({ description: "API spending estimated from the price known when each call ended, for calls with no reported cost" }),
  unknownCost: z.number().openapi({ description: "API calls whose cost is neither reported nor estimable" }),
  apiEquivalent: z.number().nullable().openapi({ description: "Subscription calls only: what they'd cost at published API rates. Not a charge" }),
  uncompared: z.number().openapi({ description: "Subscription calls with no published API price to compare with" }),
};
const Billing = z.enum(["api", "subscription"]);
const UsageTotalsView = z.object(Totals).openapi("UsageTotals");
const UsageView = z
  .object({
    since: z.string().datetime().nullable().openapi({ description: "When the oldest kept record started: usage is counted from then on" }),
    from: z.string().datetime().nullable(),
    totals: UsageTotalsView,
    api: UsageTotalsView,
    subscription: UsageTotalsView,
    byProvider: z.array(z.object({ ...Totals, key: z.string(), label: z.string(), billing: Billing })),
    byModel: z.array(z.object({ ...Totals, key: z.string(), label: z.string(), provider: z.string(), providerLabel: z.string(), billing: Billing })),
    byKind: z.array(z.object({ ...Totals, key: z.string(), label: z.string(), kind: z.enum(usageKindList) })),
    sessions: z.array(z.object({ ...Totals, key: z.string(), label: z.string(), deleted: z.boolean(), lastAt: z.string().datetime() })),
    runs: z.array(z.object({
      ...Totals,
      key: z.string(),
      label: z.string(),
      kind: z.enum(usageKindList),
      session: z.string().nullable().openapi({ description: "The chat or lesson it belongs to, or null for a model test" }),
      model: z.string(),
      billing: Billing,
      status: z.enum(["completed", "failed", "cancelled"]),
      startedAt: z.string().datetime(),
    })),
    days: z.array(z.object({ day: z.string(), api: z.number(), subscription: z.number(), calls: z.number() })),
    prices: z.array(z.object({
      model: z.string(),
      label: z.string(),
      providerLabel: z.string(),
      billing: Billing,
      published: Price.nullable().openapi({ description: "The model list's current price (for a ChatGPT plan model, its API counterpart's)" }),
      custom: Price.nullable().openapi({ description: "The learner's own price, which wins over the published one" }),
    })).openapi({ description: "Models a price can be set for: those in the usage history, custom providers' models and the models in use" }),
  })
  .openapi("Usage");

const getUsage = createRoute({
  method: "get",
  path: "/usage",
  description:
    "Token usage and costs Mivra has recorded (issue #70), added up by provider, model, kind, session, run and day. Only Mivra's own calls since recording began, never account-wide usage or remaining allowance.",
  request: {
    query: z.object({
      from: z.string().datetime().optional().openapi({ description: "Only calls that started at or after this time" }),
      tz: z.coerce.number().int().min(-1000).max(1000).optional().openapi({ description: "The browser's Date#getTimezoneOffset(), for local days" }),
    }),
  },
  responses: { 200: { description: "The usage summary", content: { "application/json": { schema: UsageView } } } },
});

const clearUsage = createRoute({
  method: "delete",
  path: "/usage",
  description: "Delete every usage record. Conversations and provider settings are kept, and provider billing or quotas aren't affected; usage counts again from the next call.",
  responses: { 200: { description: "How many records were deleted", content: { "application/json": { schema: z.object({ deleted: z.number() }) } } } },
});

const setUsagePrice = createRoute({
  method: "put",
  path: "/usage/prices",
  description: "Set or (with a null price) remove the learner's own price for a model. It applies to calls that end from now on; recorded costs never change.",
  request: { body: { content: { "application/json": { schema: z.object({ model: ModelId, price: CustomPrice.nullable() }) } } } },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: z.object({ model: z.string(), price: Price.nullable() }) } } },
    400: errorResponse("Too many custom prices"),
  },
});

const notOffered = errorResponse("This server doesn't offer sign-in with ChatGPT");
const startChatGptSignIn = createRoute({
  method: "post",
  path: "/settings/chatgpt/sign-in",
  description:
    "Start signing in with ChatGPT (ADR-015). Returns the URL to open; the server listens on 127.0.0.1 for the browser to come back, and the status shows `pending` until it does. A browser on another machine finishes by posting the address it ended on to /complete.",
  request: { body: { content: { "application/json": { schema: z.object({ newAccount: z.boolean().optional() }) } } } },
  responses: {
    200: { description: "The ChatGPT sign-in page to open", content: { "application/json": { schema: z.object({ url: z.string().url() }) } } },
    404: notOffered,
    502: errorResponse("ChatGPT's sign-in service couldn't be reached"),
  },
});

const completeChatGptSignIn = createRoute({
  method: "post",
  path: "/settings/chatgpt/sign-in/complete",
  description: "Finish the pending sign-in from the address the browser ended on, when it couldn't reach 127.0.0.1 on this machine.",
  request: { body: { content: { "application/json": { schema: z.object({ address: z.string().max(8000) }) } } } },
  responses: { 200: providersResponse, 400: errorResponse("Not the address of the pending sign-in"), 404: notOffered },
});

const cancelChatGptSignIn = createRoute({
  method: "delete",
  path: "/settings/chatgpt/sign-in",
  description: "Stop waiting for a sign-in.",
  responses: { 200: providersResponse, 404: notOffered },
});

const signOutChatGpt = createRoute({
  method: "delete",
  path: "/settings/chatgpt",
  description: "Sign out of ChatGPT: ends the session at OpenAI and forgets its tokens.",
  responses: { 200: providersResponse, 404: notOffered },
});

const chatGptWelcomed = createRoute({
  method: "post",
  path: "/settings/chatgpt/welcomed",
  description: "Record that the one-time ChatGPT plan welcome was shown.",
  responses: { 200: providersResponse, 404: notOffered },
});

const checkChatGpt = createRoute({
  method: "post",
  path: "/settings/chatgpt/check",
  description: "Ask ChatGPT whether the sign-in works, by listing its models (spends no usage).",
  responses: {
    200: { description: "Whether ChatGPT accepted the sign-in", content: { "application/json": { schema: z.object({ ok: z.boolean(), message: z.string().optional() }) } } },
    404: notOffered,
  },
});

/** How long a client waiting on a lesson is held before it asks again. */
const LESSON_WAIT_MS = 20_000;

const listMessages = createRoute({
  method: "get",
  path: "/sessions/{id}/messages",
  request: { params: SessionParams },
  responses: {
    200: { description: "Messages in conversation order", content: { "application/json": { schema: z.array(Message) } } },
    404: errorResponse("Unknown session"),
  },
});

const stopChat = createRoute({
  method: "post", path: "/sessions/{id}/stop",
  request: {
    params: SessionParams,
    body: { content: { "application/json": { schema: z.object({ messageId: z.string().min(1).max(128) }) } } },
  },
  responses: { 204: { description: "Cancellation requested (also succeeds when already finished)" } },
});

const continuationStream = createRoute({
  method: "get", path: "/sessions/{id}/continuation",
  request: { params: SessionParams },
  responses: {
    200: { description: "Replay and subscribe to the redacted continuation UI message stream", content: { "text/event-stream": { schema: z.string() } } },
    204: { description: "No continuation is running" },
    404: errorResponse("Unknown session"),
  },
});

const chat = createRoute({
  method: "post",
  path: "/sessions/{id}/chat",
  description:
    "Append a user message and stream the assistant reply as an AI SDK UI message stream (Server-Sent Events). The server owns history; send only the new message. Message ids are single-use, so a retried request with the same id is rejected rather than generating twice.",
  request: {
    params: SessionParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({ message: Message, documentIds: z.array(z.string()).max(20).optional(), lessonId: z.string().max(128).optional() }),
        },
      },
    },
  },
  responses: {
    200: { description: "UI message stream", content: { "text/event-stream": { schema: z.string() } } },
    400: errorResponse("Invalid message"),
    404: errorResponse("Unknown session"),
    409: errorResponse("Message id already used, or a reply is already in progress for this session"),
    500: errorResponse("The model could not be started"),
  },
});

const submitAttemptRoute = createRoute({
  method: "post",
  path: "/artifacts/{id}/attempts",
  description:
    "Submit the learner's answer to a check artifact. The server grades it deterministically and returns the artifact view with the grade, which reveals the correct answer. One attempt per check.",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ answer: z.unknown() }) } } },
  },
  responses: {
    201: { description: "Graded; the artifact view including latestAttempt", content: { "application/json": { schema: ArtifactView } } },
    400: errorResponse("Invalid answer, or the artifact isn't a check"),
    404: errorResponse("Unknown artifact"),
    409: errorResponse("Already answered, or the check was discarded"),
  },
});

const listMemories = createRoute({
  method: "get",
  path: "/memories",
  responses: {
    200: { description: "Memories in force, newest first", content: { "application/json": { schema: z.array(MemoryView) } } },
  },
});

const editMemory = createRoute({
  method: "patch",
  path: "/memories/{id}",
  description: "The learner's correction of a memory.",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: MemoryEdit } } },
  },
  responses: {
    200: { description: "The edited memory", content: { "application/json": { schema: MemoryView } } },
    404: errorResponse("Unknown memory"),
    409: errorResponse("Held until a check is answered"),
  },
});

const deleteMemory = createRoute({
  method: "delete",
  path: "/memories/{id}",
  description: "Permanently deletes a memory and the earlier versions it replaced.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
    404: errorResponse("Unknown memory"),
  },
});

const listDocuments = createRoute({
  method: "get",
  path: "/sessions/{id}/documents",
  request: { params: SessionParams },
  responses: {
    200: { description: "The session's documents in upload order", content: { "application/json": { schema: z.array(DocumentView) } } },
    404: errorResponse("Unknown session"),
  },
});

/** Documented only: the handler streams the body, which the request validator would buffer whole. */
const uploadDocument = createRoute({
  method: "post",
  path: "/sessions/{id}/documents",
  description:
    "Attach a PDF or PPTX file, up to 25 MB. The server extracts its text locally and keeps only that, not the file. Images and diagrams aren't read. The type is decided by the file's content, not its name.",
  request: {
    params: SessionParams,
    body: { content: { "multipart/form-data": { schema: z.object({ file: z.string().openapi({ format: "binary" }) }) } } },
  },
  responses: {
    201: { description: "The stored document", content: { "application/json": { schema: DocumentView } } },
    400: errorResponse("Not a multipart upload with a file field, or it didn't finish"),
    404: errorResponse("Unknown session"),
    409: errorResponse("The session has too many documents"),
    413: errorResponse("File too large"),
    415: errorResponse("Not a PDF or PPTX, whatever its name says"),
    422: errorResponse("Scanned, password-protected, damaged, or too demanding to read safely"),
    429: errorResponse("Too many uploads in progress"),
  },
});

const deleteDocument = createRoute({
  method: "delete",
  path: "/documents/{id}",
  description: "Removes a document and its text from storage and search. Replies already written from it stay in the conversation.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
    404: errorResponse("Unknown document"),
  },
});

const ImportParams = z.object({ id: z.string() });

const listImports = createRoute({
  method: "get",
  path: "/imports",
  description: "Imported Obsidian vaults, oldest first (ADR-014).",
  responses: {
    200: { description: "The imports", content: { "application/json": { schema: z.array(VaultImportView) } } },
  },
});

const createImport = createRoute({
  method: "post",
  path: "/imports",
  description:
    "Imports an Obsidian vault from its Markdown files. Only `.md` files outside hidden folders such as `.obsidian` are read; anything else is skipped and reported. No model runs: notes, links, tags and searchable chunks come from the text alone.",
  request: { body: { content: { "application/json": { schema: VaultImportInput } } } },
  responses: {
    201: { description: "What the import stored", content: { "application/json": { schema: VaultImportResult } } },
    400: errorResponse("Invalid files"),
    409: errorResponse("An import with this name already exists"),
    413: errorResponse("Request too large"),
  },
});

const replaceImportFiles = createRoute({
  method: "put",
  path: "/imports/{id}/files",
  description: "Re-imports a vault as a snapshot: changed notes are rewritten, new ones added, and notes no longer sent removed. Unchanged notes are left as they are.",
  request: { params: ImportParams, body: { content: { "application/json": { schema: VaultSnapshotInput } } } },
  responses: {
    200: { description: "What the re-import changed", content: { "application/json": { schema: VaultImportResult } } },
    400: errorResponse("Invalid files"),
    404: errorResponse("Unknown import"),
    413: errorResponse("Request too large"),
  },
});

const deleteImport = createRoute({
  method: "delete",
  path: "/imports/{id}",
  description: "Removes an import and all of its notes from storage and search.",
  request: { params: ImportParams },
  responses: {
    204: { description: "Deleted" },
    404: errorResponse("Unknown import"),
  },
});

const ZipUpload = z.object({ file: z.string().openapi({ format: "binary" }) });
const zipErrors = {
  400: errorResponse("Not a multipart upload with one file field, or it didn't finish"),
  413: errorResponse("Zip, or its notes unpacked, too large"),
  415: errorResponse("Not a zip"),
  422: errorResponse("Damaged, password-protected, too many entries, unsafe entry names, or no notes"),
  429: errorResponse("Another vault is importing"),
} as const;

/** Documented only: the handler streams the body, which the request validator would buffer whole. */
const createImportFromZip = createRoute({
  method: "post",
  path: "/imports/zip",
  description:
    "Imports a vault uploaded as a .zip of up to 64 MB, for browsers that can't pick a folder. Only `.md` entries outside hidden folders are unpacked, in memory and in a subprocess with limits; symbolic links and attachments are skipped. When every entry sits in one top folder, that folder is dropped from the paths. `name` defaults to the zip's file name.",
  request: {
    body: { content: { "multipart/form-data": { schema: ZipUpload.extend({ name: z.string().optional() }) } } },
  },
  responses: {
    201: { description: "What the import stored", content: { "application/json": { schema: VaultImportResult } } },
    409: errorResponse("An import with this name already exists"),
    ...zipErrors,
  },
});

/** Documented only, as createImportFromZip. */
const replaceImportFromZip = createRoute({
  method: "put",
  path: "/imports/{id}/zip",
  description: "Re-imports a vault from a .zip as a snapshot, with the same limits as POST /imports/zip.",
  request: { params: ImportParams, body: { content: { "multipart/form-data": { schema: ZipUpload } } } },
  responses: {
    200: { description: "What the re-import changed", content: { "application/json": { schema: VaultImportResult } } },
    404: errorResponse("Unknown import"),
    ...zipErrors,
  },
});

const getImportGraph = createRoute({
  method: "get",
  path: "/imports/{id}/graph",
  description: "An import's notes and the links between them. Links to notes that aren't in the vault have `to: null`.",
  request: { params: ImportParams },
  responses: {
    200: { description: "The graph", content: { "application/json": { schema: NoteGraph } } },
    404: errorResponse("Unknown import"),
  },
});

const getNote = createRoute({
  method: "get",
  path: "/notes/{id}",
  description: "One imported note. Notes are read-only: they change only when their vault is imported again.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The note", content: { "application/json": { schema: NoteView } } },
    404: errorResponse("Unknown note"),
  },
});

const zipImportErrorStatus = { not_found: 404, duplicate_name: 409, bad_request: 400, too_large: 413, wrong_type: 415, unreadable: 422, busy: 429 } as const satisfies Record<
  ZipImportError["kind"],
  number
>;

const attachErrorStatus = { not_found: 404, bad_request: 400, limit: 409, too_large: 413, wrong_type: 415, unreadable: 422, busy: 429 } as const satisfies Record<
  AttachError["kind"],
  number
>;

const turnErrorStatus = { not_found: 404, invalid: 400, conflict: 409, unavailable: 500 } as const satisfies Record<
  TurnError["kind"],
  number
>;

const attemptErrorStatus = { not_found: 404, invalid: 400, conflict: 409 } as const;

function toSessionJson(row: SessionRow & { courseId?: string | null; icon?: string | null }) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    courseId: row.courseId ?? null,
    // Only a name from the fixed list leaves the server, whatever the column holds.
    icon: CourseIcon.safeParse(row.icon).data ?? null,
  };
}

function toCourseJson(row: CourseRow, store: SessionStore, lessons: LessonStore): CourseView {
  const syllabus = store.latestSyllabus(row.id);
  const started = new Set(lessons.listLessons(row.id).map((l) => l.topicId));
  return {
    id: row.id,
    sessionId: row.sessionId,
    goal: row.goal,
    status: row.status,
    syllabus: syllabus
      ? {
          version: syllabus.version,
          source: syllabus.source,
          reason: syllabus.reason,
          changedTopicIds: syllabus.changedTopicIds,
          canUndo: row.status === "active" && syllabus.source === "adaptive" && !syllabus.changedTopicIds.some((id) => started.has(id)),
          topics: syllabus.topics,
          known: syllabus.known,
          createdAt: syllabus.createdAt.toISOString(),
        }
      : null,
    interviewMessageId: store.interviewMessageId(row.id),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Leaves out everything a held memory says: it could give away an unanswered check. */
function toMemoryJson(row: MemoryRow & { held: boolean }): MemoryView {
  return {
    id: row.id,
    kind: row.kind,
    held: row.held,
    text: row.held ? null : row.text,
    concept: row.held ? null : row.concept,
    basis: row.held ? null : row.basis,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}

function toNoteJson(row: NoteRow & { tags: string[] }): NoteView {
  return {
    id: row.id,
    importId: row.importId,
    path: row.path,
    title: row.title,
    aliases: row.aliases,
    tags: row.tags,
    body: row.body,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocumentJson(row: DocumentRow): DocumentView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    filename: row.filename,
    kind: row.kind,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    pagesWithText: row.pagesWithText,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

const uploadOf = (c: Context) => ({ body: c.req.raw.body, contentType: c.req.header("content-type"), contentLength: c.req.header("content-length") });

export function createApp({ db, model, models: modelOptions = {}, security, providers = { credentials: memoryCredentials() }, plugins = [coreLearning, coreMemory, coreCourse], extractDocument, unzipVault }: AppDeps) {
  const store = createSessionStore(db);
  const { credentials, check, isLocal = isLoopbackPeer, chatgpt, fetch: fetchImpl = fetch } = providers;
  const settingsStore = createSettingsStore(db);
  // Custom OpenAI-compatible providers (issue #69): configuration in settings, keys in the credential store.
  const custom = createCustomProviders({ settings: settingsStore, credentials, env: providers.custom?.env, fetch: providers.custom?.fetch });
  const providerKeys = (c: Context) => ({ providers: credentials.views(), custom: custom.list(), chatgpt: chatgpt?.view() ?? null, canEdit: isLocal(c) });
  const notLocal = "API keys can only be changed on the computer running Mivra. Use `mivra auth set` there.";
  const fromEnv = "This key comes from an environment variable. Change or unset it there.";
  const notLocalProvider = "Providers can only be changed on the computer running Mivra.";
  const builtInCatalog = modelOptions.catalog ?? staticCatalog([]);
  // Custom providers' models join the catalog, each under its own provider (issue #69).
  const catalog: ModelCatalog = {
    async list() {
      const { models: listed, state } = await builtInCatalog.list();
      const own = custom.catalog();
      return { models: [...own, ...listed], state: state === "unavailable" && own.length > 0 ? "stale" : state };
    },
  };
  const models = createModelSettings({
    settings: settingsStore,
    catalog,
    defaults: modelOptions.defaults,
    suggested: modelOptions.suggested,
  });
  // A custom model is called with its own provider's URL and key, never through the built-in registry; anything
  // else goes to `model`. The configuration is read when a run starts, so a run keeps it to the end.
  const resolveModel = (selection: ModelSelection): LanguageModel =>
    selection.model.startsWith(CUSTOM_PREFIX) ? custom.languageModel(selection) : model(selection);
  // A custom model's run records its endpoint, so reasoning never replays to another destination.
  const withEndpoint = (selection: ModelSelection): ModelSelection => {
    const endpoint = selection.model.startsWith(CUSTOM_PREFIX) ? custom.endpointFor(selection.model) : undefined;
    return endpoint ? { ...selection, endpoint } : selection;
  };
  /** Why a task's override can't run now, or null. Reuses the custom providers' own messages (issue #69). */
  const taskProblem = async (selection: ModelSelection) =>
    custom.unavailable(selection.model)?.replace(/ Choose another model in the picker under the message box\.$/, "") ??
    providerProblem(selection.model) ??
    (await models.overrideProblem(selection));
  /**
   * A built-in model whose provider can't be called now. Checked apart from the picker's list, which always offers
   * the default model, so an override of the default still fails clearly once its provider's key is gone.
   */
  const providerProblem = (modelId: string): string | null => {
    const provider = modelId.slice(0, modelId.indexOf(":"));
    if ((providerIds as readonly string[]).includes(provider) && !credentials.keys()[provider as ProviderId]) {
      return "Its provider has no API key set up any more.";
    }
    if (provider === "chatgpt" && chatgpt && !chatgpt.view().signedIn) return "Mivra isn't signed in with ChatGPT any more.";
    return null;
  };
  const taskView = async (task: ModelTask) => {
    const override = models.override(task);
    return { id: task, override, effective: override ?? models.current(), unavailable: override ? await taskProblem(override) : null };
  };
  const runModels = {
    forRun: () => withEndpoint(models.forRun()),
    /**
     * The model for a background task's job starting now (ADR-012, option D): its override, or else the main
     * selection as it is now. An override that can't run fails the job rather than falling back to another model.
     */
    async forTask(task: ModelTask): Promise<ModelSelection> {
      const override = models.override(task);
      if (!override) return runModels.forRun();
      const problem = await taskProblem(override);
      if (problem) {
        throw new TaskModelError(
          `The model chosen for lessons in Settings (${override.model}) can't be used: ${problem} Choose another lesson model under Settings → Models, or set it back to Use main model.`,
        );
      }
      return withEndpoint(override);
    },
  };
  store.recoverInterruptedRuns();
  const lessons = createLessonStore(db);
  lessons.recoverInterrupted();
  const registry = createCapabilityRegistry(plugins);
  const noteStore = createNoteStore(db);
  // Usage accounting (issue #70): every model call is recorded, with the price known when it ended.
  const usageStore = createUsageStore(db);
  const customPrices = createCustomPrices(settingsStore);
  const providerLabel = (provider: string) =>
    (provider.startsWith(CUSTOM_PREFIX) ? custom.names().find((p) => p.id === provider)?.name : undefined) ?? BUILT_IN_PROVIDERS[provider];
  const describeModel = async (id: string): Promise<ModelFacts> => {
    const own = customPrices.get(id);
    const listed = (await catalog.list()).models.find((m) => m.id === id);
    const facts = { modelLabel: listed?.name ?? null, providerLabel: providerLabel(providerOf(id)) ?? providerOf(id) };
    // A ChatGPT plan model has no price of its own; its API counterpart's published price is only a comparison, so a
    // learner's own price never stands in for it (issue #70: "at published API rates").
    if (id.startsWith("chatgpt:")) return { ...facts, price: listed?.apiPrice ? { ...listed.apiPrice, source: "catalog" } : null };
    return { ...facts, price: own ? { ...own, source: "custom" } : listed?.price ? { ...listed.price, source: "catalog" } : null };
  };
  const usage = createUsageTracker({ store: usageStore, describe: describeModel });
  const turns = createTurnRunner({ store, registry, model: resolveModel, models: runModels, lessons, notes: noteStore, usage });
  const generator = createLessonGenerator({ store, lessons, registry, model: resolveModel, models: runModels, notes: noteStore, usage });
  /** A session's name on the Usage page, read now: usage records keep no titles, and a deleted chat has none. */
  const sessionLabel = (id: string) => {
    const lesson = lessons.findLessonBySession(id);
    if (lesson) return { label: `Lesson: ${lesson.topicTitle}`, deleted: false };
    const session = store.findSession(id);
    return session ? { label: session.title, deleted: false } : { label: "Deleted chat", deleted: true };
  };
  const usageView = async (from: Date | undefined, offsetMinutes: number) => {
    // A call that has just ended is still being written; wait for it, so a page opened right after a reply shows it.
    await usage.settled();
    const rows = usageStore.list(from);
    const summary = summarise(rows, { offsetMinutes, providerLabel });
    const listed = (await catalog.list()).models;
    const own = customPrices.all();
    // Models a price can be set for: anything recorded, every custom provider's model, and the models in use.
    const priceable = new Set<string>([
      ...usageStore.list().map((r) => r.model),
      ...custom.catalog().map((m) => m.id),
      models.current().model,
      ...modelTasks.flatMap((task) => models.override(task)?.model ?? []),
      ...Object.keys(own),
    ]);
    const recordedLabels = new Map(rows.map((r) => [r.model, r.modelLabel] as const));
    return {
      since: usageStore.oldest()?.toISOString() ?? null,
      from: from?.toISOString() ?? null,
      totals: summary.totals,
      api: summary.api,
      subscription: summary.subscription,
      byProvider: summary.byProvider,
      byModel: summary.byModel,
      byKind: summary.byKind,
      sessions: summary.bySession.map(({ lastAt, ...group }) => ({ ...group, ...sessionLabel(group.key), lastAt: lastAt.toISOString() })),
      runs: summary.runs.map(({ startedAt, sessionId, ...run }) => ({ ...run, session: sessionId ? sessionLabel(sessionId).label : null, startedAt: startedAt.toISOString() })),
      days: summary.days,
      prices: [...priceable].map((model) => {
        const entry = listed.find((m) => m.id === model);
        const published = model.startsWith("chatgpt:") ? entry?.apiPrice : entry?.price;
        return {
          model,
          label: entry?.name ?? recordedLabels.get(model) ?? model,
          providerLabel: providerLabel(providerOf(model)) ?? providerOf(model),
          billing: billingOf(model),
          published: published ?? null,
          custom: own[model] ?? null,
        };
      }),
    };
  };
  lessons.onChange(generator.changed);
  const lessonJson = (id: string) => {
    const row = lessons.findLesson(id);
    if (!row) return undefined;
    const lesson = lessonView(row, { store, lessons, registry });
    return { lesson, revision: lessonRevision(lesson) };
  };
  const attachDocument = createDocumentAttacher({ store, ...(extractDocument ? { extract: extractDocument } : {}) });

  const importZip = createZipImporter({ store: noteStore, ...(unzipVault ? { unzip: unzipVault } : {}) });

  const base = new OpenAPIHono();
  base.openAPIRegistry.registerPath(uploadDocument);
  base.openAPIRegistry.registerPath(createImportFromZip);
  base.openAPIRegistry.registerPath(replaceImportFromZip);
  // A vault arrives as one JSON body; refuse anything larger before it's read, let alone parsed.
  const vaultBodyLimit = bodyLimit({
    maxSize: MAX_VAULT_BYTES,
    onError: (c) => c.json({ error: `An import can send at most ${MAX_VAULT_BYTES / (1024 * 1024)} MB. Leave attachments out, or import the vault in parts.` }, 413),
  });
  base.use("/imports", vaultBodyLimit);
  base.use("/imports/:id/files", vaultBodyLimit);
  const api = base
    .openapi(health, (c) => c.json({ ok: true as const }, 200))
    .openapi(listSessions, (c) => c.json(store.listSessions().map(toSessionJson), 200))
    .openapi(createSession, async (c) => {
      const body = c.req.header("content-type")?.includes("application/json") ? c.req.valid("json") : {};
      return c.json(toSessionJson(store.createSession(body?.title)), 201);
    })
    .openapi(renameSession, (c) => {
      const { id } = c.req.valid("param");
      const row = store.renameSession(id, c.req.valid("json").title);
      if (!row) return c.json({ error: "Session not found" }, 404);
      const course = store.findCourseBySession(id);
      return c.json(toSessionJson({ ...row, courseId: course?.id ?? null, icon: course?.icon ?? null }), 200);
    }, (result, c) => {
      // The web UI shows `error` as is, so say what a title needs rather than return Zod's issues.
      if (!result.success) return c.json({ error: "A title needs 1 to 120 characters." }, 400);
    })
    .openapi(deleteSession, (c) => {
      const { id } = c.req.valid("param");
      if (!store.findSession(id)) return c.json({ error: "Session not found" }, 404);
      if (lessons.findLessonBySession(id)) return c.json({ error: "A lesson's chat is deleted with its course" }, 409);
      // Stop running replies and lesson generation first, so nothing writes into the deleted rows.
      // Their endings run later and find nothing to record.
      const course = store.findCourseBySession(id);
      const lessonIds = course ? lessons.listLessons(course.id).map((l) => l.id) : [];
      for (const lessonId of lessonIds) generator.stop(lessonId);
      for (const sessionId of store.ownedSessionIds(id)) turns.stopSession(sessionId);
      if (!store.deleteSession(id)) return c.json({ error: "Session not found" }, 404);
      // Wake anyone waiting on a deleted lesson, so they see it is gone.
      for (const lessonId of lessonIds) generator.changed(lessonId);
      return c.body(null, 204);
    })
    .openapi(startCourse, (c) => {
      const { course, session } = store.createCourse(c.req.valid("json").goal);
      return c.json({ course: toCourseJson(course, store, lessons), session: toSessionJson({ ...session, courseId: course.id }) }, 201);
    })
    .openapi(getCourse, (c) => {
      const course = store.findCourseBySession(c.req.valid("param").id);
      if (!course) return c.json({ error: "This session isn't a course" }, 404);
      return c.json(toCourseJson(course, store, lessons), 200);
    })
    .openapi(listCourseLessons, (c) => {
      const course = store.findCourse(c.req.valid("param").id);
      if (!course) return c.json({ error: "Course not found" }, 404);
      return c.json(courseLessons(course.id, { store, lessons }), 200);
    })
    .openapi(startLesson, (c) => {
      const course = store.findCourse(c.req.valid("param").id);
      if (!course) return c.json({ error: "Course not found" }, 404);
      const { topicId } = c.req.valid("json");
      const topics = store.latestSyllabus(course.id)?.topics;
      if (!topics) return c.json({ error: "The course has no syllabus yet" }, 409);
      const position = topics.findIndex((t) => t.id === topicId);
      if (position < 0) return c.json({ error: "Topic not found" }, 404);
      const existing = lessons.listLessons(course.id).find((l) => l.topicId === topicId);
      if (!existing && courseLessons(course.id, { store, lessons }).nextTopicId !== topicId) {
        return c.json({ error: "Finish the earlier lessons first" }, 409);
      }
      const { lesson } = lessons.createLesson({ courseId: course.id, topicId, topicTitle: topics[position]!.title, position });
      generator.start(lesson.id);
      return c.json(lessonJson(lesson.id)! as never, 201);
    })
    .openapi(getLesson, async (c) => {
      const { id } = c.req.valid("param");
      const { after } = c.req.valid("query");
      const first = lessonJson(id);
      if (!first) return c.json({ error: "Lesson not found" }, 404);
      if (after === first.revision) {
        await generator.waitForChange(id, LESSON_WAIT_MS, c.req.raw.signal);
        return c.json(lessonJson(id)! as never, 200);
      }
      // Cast for the same reason as messages: hono's JSON typing recurses too deeply on artifact views.
      return c.json(first as never, 200);
    })
    .openapi(finishLesson, (c) => {
      const { id } = c.req.valid("param");
      if (!lessons.findLesson(id)) return c.json({ error: "Lesson not found" }, 404);
      if (!lessons.finishLesson(id, registry.checkKinds())) return c.json({ error: "Answer every check in the finished lesson first" }, 409);
      // Reaching the end of the syllabus completes the course (ADR-011).
      reconcileCompletion(lessons.findLesson(id)!.courseId, { store, lessons });
      generator.changed(id);
      return c.json(lessonJson(id)! as never, 200);
    })
    .openapi(retryLesson, (c) => {
      const { id } = c.req.valid("param");
      if (!lessons.findLesson(id)) return c.json({ error: "Lesson not found" }, 404);
      if (!lessons.restartLesson(id)) return c.json({ error: "This lesson didn't fail" }, 409);
      generator.start(id);
      generator.changed(id);
      return c.json(lessonJson(id)! as never, 202);
    })
    .openapi(undoSyllabusChange, (c) => {
      const course = store.findCourse(c.req.valid("param").id);
      if (!course) return c.json({ error: "Course not found" }, 404);
      const startedTopicIds = lessons.listLessons(course.id).map((l) => l.topicId);
      const undone = store.undoSyllabusChange(course.id, c.req.valid("json").version, startedTopicIds);
      if (!undone.ok) return c.json({ error: undone.reason }, 409);
      reconcileCompletion(course.id, { store, lessons });
      return c.json(toCourseJson(store.findCourse(course.id)!, store, lessons), 200);
    })
    .openapi(addToLesson, (c) => {
      const { id } = c.req.valid("param");
      const { messageId, afterSectionId, title } = c.req.valid("json");
      const lesson = lessons.findLesson(id);
      if (!lesson) return c.json({ error: "Lesson not found" }, 404);
      const course = store.findCourse(lesson.courseId)!;
      const reply = store.loadMessages(course.sessionId).find((m) => m.id === messageId && m.role === "assistant");
      const markdown = reply?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n").trim();
      if (!markdown) return c.json({ error: "That isn't one of the tutor's answers in this course" }, 400);
      const changed = lessons.changeLesson(id, "Added the tutor's answer", [{ op: "insert", afterSectionId, title, markdown: markdown.slice(0, 6000) }]);
      if (!changed.ok) {
        return changed.reason.startsWith("Unknown") ? c.json({ error: "Section not found" }, 404) : c.json({ error: changed.reason }, 409);
      }
      generator.changed(id);
      return c.json(lessonJson(id)! as never, 201);
    })
    .openapi(listMessages, (c) => {
      const { id } = c.req.valid("param");
      if (!store.findSession(id)) return c.json({ error: "Session not found" }, 404);
      // Cast to the documented wire shape: hono's JSON typing recurses too deeply on the AI SDK's UIMessage type.
      const messages = presentMessages(store.loadMessages(id), registry, store);
      return c.json(messages as unknown as z.infer<typeof Message>[], 200);
    })
    .openapi(continuationStream, (c) => {
      const { id } = c.req.valid("param");
      if (!store.findSession(id)) return c.json({ error: "Session not found" }, 404);
      return turns.subscribeContinuation(id);
    })
    .openapi(stopChat, (c) => {
      turns.stopTurn(c.req.valid("param").id, c.req.valid("json").messageId);
      return c.body(null, 204);
    })
    .openapi(chat, async (c) => {
      const result = await turns.startTurn({
        sessionId: c.req.valid("param").id,
        message: c.req.valid("json").message,
        documentIds: c.req.valid("json").documentIds,
        lessonId: c.req.valid("json").lessonId,
        abortSignal: c.req.raw.signal,
      });
      if (!result.ok) return c.json({ error: result.error.message }, turnErrorStatus[result.error.kind]);
      return result.response;
    })
    .openapi(submitAttemptRoute, (c) => {
      const result = submitAttempt(
        { artifactId: c.req.valid("param").id, answer: c.req.valid("json").answer },
        { registry, store, durableOnceSaved: lessons.isLessonArtifact },
      );
      if (!result.ok) return c.json({ error: result.error.message }, attemptErrorStatus[result.error.kind]);
      const artifact = store.findArtifact(c.req.valid("param").id)!;
      // A lesson's checks don't continue a chat: the learner reads on, and the lesson page updates.
      const lesson = lessons.findLessonBySession(artifact.sessionId) ?? lessons.lessonForArtifact(artifact.id);
      if (lesson) {
        generator.changed(lesson.id);
        return c.json(result.view as never, 201);
      }
      // The durable claim in startContinuation makes retries and other tabs harmless.
      void turns.continueAfterAnswer(artifact.sessionId);
      // Cast for the same reason as messages: hono's JSON typing recurses too deeply on the view type.
      return c.json(result.view as never, 201);
    })
    .openapi(listModels, async (c) => {
      const picker = await models.picker();
      return c.json({ ...picker, providers: custom.names(), unavailable: custom.unavailable(picker.current.model) }, 200);
    })
    .openapi(selectModel, async (c) => {
      const result = await models.select(c.req.valid("json"));
      if (!result.ok) return c.json({ error: result.message }, result.kind === "invalid" ? 400 : 503);
      return c.json(result.selection, 200);
    })
    .openapi(listModelTasks, async (c) => c.json({ tasks: await Promise.all(modelTasks.map(taskView)) }, 200))
    .openapi(setModelTask, async (c) => {
      const { task } = c.req.valid("param");
      const result = await models.setOverride(task, c.req.valid("json"));
      if (!result.ok) return c.json({ error: result.message }, result.kind === "invalid" ? 400 : 503);
      return c.json(await taskView(task), 200);
    })
    .openapi(resetModelTask, async (c) => {
      const { task } = c.req.valid("param");
      models.clearOverride(task);
      return c.json(await taskView(task), 200);
    })
    .openapi(listProviderKeys, (c) => c.json(providerKeys(c), 200))
    .openapi(setProviderKey, (c) => {
      if (!isLocal(c)) return c.json({ error: notLocal }, 403);
      const key = ApiKey.safeParse(c.req.valid("json").key);
      if (!key.success) return c.json({ error: key.error.issues[0]!.message }, 400);
      if (!credentials.set(c.req.valid("param").id, key.data).ok) return c.json({ error: fromEnv }, 409);
      return c.json(providerKeys(c), 200);
    })
    .openapi(removeProviderKey, (c) => {
      if (!isLocal(c)) return c.json({ error: notLocal }, 403);
      const removed = credentials.remove(c.req.valid("param").id);
      if (removed === "env") return c.json({ error: fromEnv }, 409);
      if (!removed) return c.json({ error: "No saved key for this provider" }, 404);
      return c.json(providerKeys(c), 200);
    })
    .openapi(createCustomProvider, (c) => {
      if (!isLocal(c)) return c.json({ error: notLocalProvider }, 403);
      const body = c.req.valid("json");
      try {
        custom.create({ name: body.name, baseUrl: body.baseUrl || null, ...(body.key ? { key: body.key } : {}), models: body.models });
      } catch (error) {
        if (error instanceof CustomProviderError) return c.json({ error: error.message }, 400);
        throw error;
      }
      return c.json(providerKeys(c), 201);
    })
    .openapi(updateCustomProvider, (c) => {
      if (!isLocal(c)) return c.json({ error: notLocalProvider }, 403);
      const body = c.req.valid("json");
      try {
        custom.update(c.req.valid("param").id, {
          ...body,
          // An empty field means "not set": no saved URL (so the environment's applies), or no saved key.
          ...(body.baseUrl === "" ? { baseUrl: null } : {}),
          ...(body.key === "" ? { key: null } : {}),
        });
      } catch (error) {
        if (error instanceof CustomProviderNotFound) return c.json({ error: "No such provider" }, 404);
        if (error instanceof CustomProviderError) return c.json({ error: error.message }, 400);
        throw error;
      }
      return c.json(providerKeys(c), 200);
    })
    .openapi(removeCustomProvider, (c) => {
      if (!isLocal(c)) return c.json({ error: notLocalProvider }, 403);
      if (!custom.remove(c.req.valid("param").id)) return c.json({ error: "No such provider" }, 404);
      return c.json(providerKeys(c), 200);
    })
    // Listing and testing use the URL and key already set on this machine, like Check, so any client may ask.
    .openapi(refreshCustomModels, async (c) => {
      try {
        await custom.refresh(c.req.valid("param").id);
      } catch (error) {
        if (error instanceof CustomProviderNotFound) return c.json({ error: "No such provider" }, 404);
        if (error instanceof CustomProviderError) return c.json({ error: error.message }, 400);
        throw error;
      }
      return c.json(providerKeys(c), 200);
    })
    .openapi(testCustomModel, async (c) => {
      let result;
      try {
        // Closing the request (the learner cancelled) aborts the test.
        // A test spends tokens like any other call, so it's counted as usage (issue #70).
        const testRun = randomUUID();
        result = await custom.test(c.req.valid("param").id, c.req.valid("json").model, c.req.raw.signal, (model) =>
          usage.middleware({ kind: "test", selection: { model, effort: null }, runId: testRun }));
      } catch (error) {
        if (error instanceof CustomProviderNotFound) return c.json({ error: "No such provider" }, 404);
        if (error instanceof CustomProviderError) return c.json({ error: error.message }, 400);
        throw error;
      }
      return c.json({ result, providers: providerKeys(c) }, 200);
    })
    .openapi(checkProviderKeyRoute, async (c) => {
      const provider = c.req.valid("param").id;
      const key = credentials.keys()[provider];
      if (!key) return c.json({ error: "No key set for this provider" }, 404);
      if (!check) return c.json({ ok: true }, 200);
      return c.json(await check(provider, key), 200);
    })
    // Unlike API keys (ADR-013), any client the host guard lets in may sign in with ChatGPT (ADR-015): a tailnet
    // browser finishes by pasting the address back, and the code in it is useless without the server's PKCE
    // verifier. Tokens still never leave the server.
    .openapi(startChatGptSignIn, async (c) => {
      if (!chatgpt) return c.json({ error: "Sign-in with ChatGPT isn't offered here" }, 404);
      try {
        const started = await chatgpt.startSignIn({ newAccount: c.req.valid("json").newAccount });
        // Nobody awaits it here: the client polls the status.
        void started.done;
        return c.json({ url: started.url }, 200);
      } catch (error) {
        return c.json({ error: error instanceof ChatGptError ? error.message : "Couldn't start signing in with ChatGPT. Try again." }, 502);
      }
    })
    .openapi(completeChatGptSignIn, async (c) => {
      if (!chatgpt) return c.json({ error: "Sign-in with ChatGPT isn't offered here" }, 404);
      try {
        await chatgpt.completeSignIn(c.req.valid("json").address);
      } catch (error) {
        return c.json({ error: error instanceof ChatGptError ? error.message : "Couldn't finish signing in. Try again." }, 400);
      }
      return c.json(providerKeys(c), 200);
    })
    .openapi(cancelChatGptSignIn, (c) => {
      if (!chatgpt) return c.json({ error: "Sign-in with ChatGPT isn't offered here" }, 404);
      chatgpt.cancelSignIn();
      return c.json(providerKeys(c), 200);
    })
    .openapi(signOutChatGpt, async (c) => {
      if (!chatgpt) return c.json({ error: "Sign-in with ChatGPT isn't offered here" }, 404);
      await chatgpt.signOut();
      return c.json(providerKeys(c), 200);
    })
    .openapi(chatGptWelcomed, (c) => {
      if (!chatgpt) return c.json({ error: "Sign-in with ChatGPT isn't offered here" }, 404);
      chatgpt.welcomed();
      return c.json(providerKeys(c), 200);
    })
    .openapi(checkChatGpt, async (c) => {
      if (!chatgpt) return c.json({ error: "Sign-in with ChatGPT isn't offered here" }, 404);
      return c.json(await checkChatGptSignIn(chatgpt, fetchImpl), 200);
    })
    .openapi(getUsage, async (c) => {
      const { from, tz } = c.req.valid("query");
      return c.json(await usageView(from ? new Date(from) : undefined, tz ?? 0), 200);
    })
    .openapi(clearUsage, (c) => c.json({ deleted: usage.clear(() => usageStore.clear()) }, 200))
    .openapi(setUsagePrice, (c) => {
      const { model, price } = c.req.valid("json");
      if (!customPrices.set(model, price)) return c.json({ error: "Too many custom prices. Remove one you no longer need first." }, 400);
      return c.json({ model, price }, 200);
    })
    .openapi(setPinnedModels, (c) => c.json({ pinned: models.setPinned(c.req.valid("json").models) }, 200))
    .openapi(listMemories, (c) => c.json(store.listMemoriesForLearner(registry.checkKinds()).map(toMemoryJson), 200))
    .openapi(editMemory, (c) => {
      const result = store.editMemory(c.req.valid("param").id, c.req.valid("json").text, registry.checkKinds());
      if (result.ok) return c.json(toMemoryJson(result.memory), 200);
      return result.reason === "held"
        ? c.json({ error: "This memory can't be edited until the check is answered" }, 409)
        : c.json({ error: "Memory not found" }, 404);
    })
    .openapi(deleteMemory, (c) =>
      store.deleteMemory(c.req.valid("param").id) ? c.body(null, 204) : c.json({ error: "Memory not found" }, 404),
    )
    .openapi(listDocuments, (c) => {
      const { id } = c.req.valid("param");
      if (!store.findSession(id)) return c.json({ error: "Session not found" }, 404);
      return c.json(store.listDocuments(id).map(toDocumentJson), 200);
    })
    .openapi(deleteDocument, (c) =>
      store.deleteDocument(c.req.valid("param").id) ? c.body(null, 204) : c.json({ error: "Document not found" }, 404),
    )
    .openapi(listImports, (c) => c.json(noteStore.listImports().map(importView), 200))
    .openapi(createImport, async (c) => {
      const outcome = await importVault(noteStore, c.req.valid("json"));
      if (!outcome.ok) return c.json({ error: outcome.message }, 409);
      return c.json(outcome.result, 201);
    })
    .openapi(replaceImportFiles, async (c) => {
      const outcome = await importVault(noteStore, { importId: c.req.valid("param").id, files: c.req.valid("json").files });
      if (!outcome.ok) return c.json({ error: outcome.message }, 404);
      return c.json(outcome.result, 200);
    })
    .openapi(deleteImport, (c) => (noteStore.deleteImport(c.req.valid("param").id) ? c.body(null, 204) : c.json({ error: "Import not found" }, 404)))
    .openapi(getImportGraph, (c) => {
      const { id } = c.req.valid("param");
      if (!noteStore.findImport(id)) return c.json({ error: "Import not found" }, 404);
      return c.json(resolveGraph(noteStore.importGraph(id)), 200);
    })
    .openapi(getNote, (c) => {
      const note = noteStore.findNote(c.req.valid("param").id);
      return note ? c.json(toNoteJson(note), 200) : c.json({ error: "Note not found" }, 404);
    })
    .post("/sessions/:id/documents", async (c) => {
      const result = await attachDocument(
        c.req.param("id"),
        uploadOf(c),
        c.req.raw.signal,
      );
      if (!result.ok) return c.json({ error: result.error.message }, attachErrorStatus[result.error.kind]);
      return c.json(toDocumentJson(result.document), 201);
    })
    .post("/imports/zip", async (c) => {
      const outcome = await importZip({ new: true }, uploadOf(c), c.req.raw.signal);
      if (!outcome.ok) return c.json({ error: outcome.error.message }, zipImportErrorStatus[outcome.error.kind]);
      return c.json(outcome.result, 201);
    })
    .put("/imports/:id/zip", async (c) => {
      const outcome = await importZip({ importId: c.req.param("id") }, uploadOf(c), c.req.raw.signal);
      if (!outcome.ok) return c.json({ error: outcome.error.message }, zipImportErrorStatus[outcome.error.kind]);
      return c.json(outcome.result, 200);
    });


  base.doc("/doc", {
    openapi: "3.1.0",
    info: { title: "Mivra API", version: "0.0.0" },
    servers: [{ url: "/api" }],
  });

  return new OpenAPIHono()
    .use("*", hostGuard(security.allowedHosts))
    .use("/api/*", tokenGuard(security.token))
    .route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;

/** Lists ChatGPT's models with the current token: a check that spends none of the plan's usage. */
async function checkChatGptSignIn(chatgpt: ChatGptSession, fetchImpl: typeof fetch): Promise<{ ok: boolean; message?: string }> {
  let token: string;
  try {
    token = await chatgpt.accessToken();
  } catch (error) {
    return { ok: false, message: error instanceof ChatGptError ? error.message : "Couldn't renew the ChatGPT sign-in. Try again." };
  }
  let response: Response;
  try {
    response = await fetchImpl(`${CHATGPT_API}/models`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, message: "Couldn't reach ChatGPT. Check your connection and try again." };
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) return { ok: false, message: "ChatGPT didn't accept the sign-in. Sign out and sign in again." };
  return { ok: false, message: `ChatGPT answered ${response.status}. Try again later.` };
}
