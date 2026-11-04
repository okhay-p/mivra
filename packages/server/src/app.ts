import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { LanguageModel } from "ai";
import { AddToLesson, ArtifactView, CourseLessonsView, CourseView, DocumentView, LessonView, MemoryEdit, MemoryView, StartCourse } from "@mivra/protocol";
import { ApiKey, memoryCredentials, providerIds, type CredentialStore, type ProviderId } from "./credentials.js";
import type { Db } from "./db/client.js";
import { createDocumentAttacher, type AttachError } from "./documents/attach.js";
import { reasoningEfforts, type ModelSelection } from "./model.js";
import { staticCatalog, type ModelCatalog } from "./models/catalog.js";
import type { KeyCheck } from "./models/key-check.js";
import { MAX_PINNED, ModelId, SelectionInput, createModelSettings } from "./models/selection.js";
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
import { createLessonStore, type LessonStore } from "./store/lesson-store.js";
import { createSettingsStore } from "./store/settings-store.js";
import { createSessionStore, type CourseRow, type DocumentRow, type MemoryRow, type SessionRow, type SessionStore } from "./store/session-store.js";

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
  providers?: { credentials: CredentialStore; check?: (provider: ProviderId, key: string) => Promise<KeyCheck>; isLocal?: (c: Context) => boolean };
  /** Defaults to the first-party core-learning, core-memory and core-course plugins. */
  plugins?: Plugin[];
  /** Defaults to extracting on a worker thread. */
  extractDocument?: Extract;
}

const Session = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** The course this session teaches, or null for free chat. */
    courseId: z.string().nullable(),
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
  description: "Choose the model and reasoning effort for every later run: chat, syllabus and lessons. A null effort uses the model's default. A run already streaming keeps its model.",
  request: { body: { content: { "application/json": { schema: SelectionInput } } } },
  responses: {
    200: { description: "The saved selection", content: { "application/json": { schema: Selection } } },
    400: errorResponse("Unknown model, or an effort it doesn't support"),
    503: errorResponse("The model list couldn't be loaded"),
  },
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
const ProviderKeys = z
  .object({
    providers: z.array(ProviderKey),
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

const attachErrorStatus = { not_found: 404, bad_request: 400, limit: 409, too_large: 413, wrong_type: 415, unreadable: 422, busy: 429 } as const satisfies Record<
  AttachError["kind"],
  number
>;

const turnErrorStatus = { not_found: 404, invalid: 400, conflict: 409, unavailable: 500 } as const satisfies Record<
  TurnError["kind"],
  number
>;

const attemptErrorStatus = { not_found: 404, invalid: 400, conflict: 409 } as const;

function toSessionJson(row: SessionRow & { courseId?: string | null }) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    courseId: row.courseId ?? null,
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

export function createApp({ db, model, models: modelOptions = {}, security, providers = { credentials: memoryCredentials() }, plugins = [coreLearning, coreMemory, coreCourse], extractDocument }: AppDeps) {
  const store = createSessionStore(db);
  const { credentials, check, isLocal = isLoopbackPeer } = providers;
  const providerKeys = (c: Context) => ({ providers: credentials.views(), canEdit: isLocal(c) });
  const notLocal = "API keys can only be changed on the computer running Mivra. Use `mivra auth set` there.";
  const fromEnv = "This key comes from an environment variable. Change or unset it there.";
  const models = createModelSettings({
    settings: createSettingsStore(db),
    catalog: modelOptions.catalog ?? staticCatalog([]),
    defaults: modelOptions.defaults,
    suggested: modelOptions.suggested,
  });
  store.recoverInterruptedRuns();
  const lessons = createLessonStore(db);
  lessons.recoverInterrupted();
  const registry = createCapabilityRegistry(plugins);
  const turns = createTurnRunner({ store, registry, model, models, lessons });
  const generator = createLessonGenerator({ store, lessons, registry, model, models });
  lessons.onChange(generator.changed);
  const lessonJson = (id: string) => {
    const row = lessons.findLesson(id);
    if (!row) return undefined;
    const lesson = lessonView(row, { store, lessons, registry });
    return { lesson, revision: lessonRevision(lesson) };
  };
  const attachDocument = createDocumentAttacher({ store, ...(extractDocument ? { extract: extractDocument } : {}) });

  const base = new OpenAPIHono();
  base.openAPIRegistry.registerPath(uploadDocument);
  const api = base
    .openapi(health, (c) => c.json({ ok: true as const }, 200))
    .openapi(listSessions, (c) => c.json(store.listSessions().map(toSessionJson), 200))
    .openapi(createSession, async (c) => {
      const body = c.req.header("content-type")?.includes("application/json") ? c.req.valid("json") : {};
      return c.json(toSessionJson(store.createSession(body?.title)), 201);
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
    .openapi(listModels, async (c) => c.json(await models.picker(), 200))
    .openapi(selectModel, async (c) => {
      const result = await models.select(c.req.valid("json"));
      if (!result.ok) return c.json({ error: result.message }, result.kind === "invalid" ? 400 : 503);
      return c.json(result.selection, 200);
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
    .openapi(checkProviderKeyRoute, async (c) => {
      const provider = c.req.valid("param").id;
      const key = credentials.keys()[provider];
      if (!key) return c.json({ error: "No key set for this provider" }, 404);
      if (!check) return c.json({ ok: true }, 200);
      return c.json(await check(provider, key), 200);
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
    .post("/sessions/:id/documents", async (c) => {
      const result = await attachDocument(
        c.req.param("id"),
        { body: c.req.raw.body, contentType: c.req.header("content-type"), contentLength: c.req.header("content-length") },
        c.req.raw.signal,
      );
      if (!result.ok) return c.json({ error: result.error.message }, attachErrorStatus[result.error.kind]);
      return c.json(toDocumentJson(result.document), 201);
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
