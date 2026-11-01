import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { LanguageModel } from "ai";
import { ArtifactView, DocumentView, MemoryEdit, MemoryView } from "@mivra/protocol";
import type { Db } from "./db/client.js";
import { createDocumentAttacher, type AttachError } from "./documents/attach.js";
import type { Extract } from "./documents/extract-in-worker.js";
import { coreLearning } from "./plugins/core-learning.js";
import { coreMemory } from "./plugins/core-memory.js";
import { presentMessages } from "./runtime/artifacts.js";
import { submitAttempt } from "./runtime/attempts.js";
import { createCapabilityRegistry, type Plugin } from "./runtime/capabilities.js";
import { createTurnRunner, type TurnError } from "./runtime/turn-runner.js";
import { hostGuard, tokenGuard, type SecurityConfig } from "./security.js";
import { createSessionStore, type DocumentRow, type MemoryRow, type SessionRow } from "./store/session-store.js";

export interface AppDeps {
  db: Db;
  model: () => LanguageModel;
  security: SecurityConfig;
  /** Defaults to the first-party core-learning and core-memory plugins. */
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

const listMessages = createRoute({
  method: "get",
  path: "/sessions/{id}/messages",
  request: { params: SessionParams },
  responses: {
    200: { description: "Messages in conversation order", content: { "application/json": { schema: z.array(Message) } } },
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
    body: { content: { "application/json": { schema: z.object({ message: Message }) } } },
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

function toSessionJson(row: SessionRow) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
    filename: row.filename,
    kind: row.kind,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    pagesWithText: row.pagesWithText,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createApp({ db, model, security, plugins = [coreLearning, coreMemory], extractDocument }: AppDeps) {
  const store = createSessionStore(db);
  store.recoverInterruptedRuns();
  const registry = createCapabilityRegistry(plugins);
  const turns = createTurnRunner({ store, registry, model });
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
    .openapi(listMessages, (c) => {
      const { id } = c.req.valid("param");
      if (!store.findSession(id)) return c.json({ error: "Session not found" }, 404);
      // Cast to the documented wire shape: hono's JSON typing recurses too deeply on the AI SDK's UIMessage type.
      const messages = presentMessages(store.loadMessages(id), registry, store);
      return c.json(messages as unknown as z.infer<typeof Message>[], 200);
    })
    .openapi(chat, async (c) => {
      const result = await turns.startTurn({
        sessionId: c.req.valid("param").id,
        message: c.req.valid("json").message,
        abortSignal: c.req.raw.signal,
      });
      if (!result.ok) return c.json({ error: result.error.message }, turnErrorStatus[result.error.kind]);
      return result.response;
    })
    .openapi(submitAttemptRoute, (c) => {
      const result = submitAttempt({ artifactId: c.req.valid("param").id, answer: c.req.valid("json").answer }, { registry, store });
      if (!result.ok) return c.json({ error: result.error.message }, attemptErrorStatus[result.error.kind]);
      // Cast for the same reason as messages: hono's JSON typing recurses too deeply on the view type.
      return c.json(result.view as never, 201);
    })
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
