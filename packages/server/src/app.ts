import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  type LanguageModel,
  type UIMessage,
  type UIMessageStreamOutcome,
} from "ai";
import { and, asc, desc, eq, max } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { messages, runs, sessions, type RunStatus } from "./db/schema.js";
import { hostGuard, tokenGuard, type SecurityConfig } from "./security.js";

const INSTRUCTIONS =
  "You are Mivra, a patient tutor. Explain concepts step by step, check the learner's understanding, and adapt to what they already know.";

export interface AppDeps {
  db: Db;
  model: () => LanguageModel;
  security: SecurityConfig;
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

class Conflict extends Error {}

function toSessionJson(row: typeof sessions.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function firstText(message: UIMessage): string | undefined {
  const part = message.parts.find((p) => p.type === "text");
  return part && "text" in part ? part.text : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The model request failed";
}

function runStatusFor(outcome: UIMessageStreamOutcome): RunStatus {
  if (outcome.status === "completed") return "completed";
  if (outcome.status === "failed") return "failed";
  return "cancelled";
}

export function createApp({ db, model, security }: AppDeps) {
  // A run still marked running belongs to a previous server process that stopped mid-reply.
  db.update(runs)
    .set({ status: "failed", error: "The server stopped before the reply finished", endedAt: new Date() })
    .where(eq(runs.status, "running"))
    .run();

  const loadMessages = (sessionId: string): UIMessage[] =>
    db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.seq))
      .all()
      .map((row) => ({ id: row.id, role: row.role, parts: row.parts as UIMessage["parts"] }));

  const findSession = (id: string) => db.select().from(sessions).where(eq(sessions.id, id)).get();

  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
  const nextSeq = (tx: Tx, sessionId: string) =>
    (tx.select({ value: max(messages.seq) }).from(messages).where(eq(messages.sessionId, sessionId)).get()?.value ?? 0) + 1;

  /** Saves the user message and claims the session's single running slot, atomically. */
  const startRun = (session: typeof sessions.$inferSelect, message: UIMessage): string =>
    db.transaction((tx) => {
      if (tx.select({ id: messages.id }).from(messages).where(eq(messages.id, message.id)).get()) {
        throw new Conflict("This message id has already been used");
      }
      const running = tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.sessionId, session.id), eq(runs.status, "running")))
        .get();
      if (running) throw new Conflict("A reply is already in progress for this session");

      const now = new Date();
      const seq = nextSeq(tx, session.id);
      tx.insert(messages)
        .values({ id: message.id, sessionId: session.id, seq, role: "user", parts: message.parts, createdAt: now })
        .run();
      const runId = randomUUID();
      tx.insert(runs)
        .values({ id: runId, sessionId: session.id, userMessageId: message.id, status: "running", startedAt: now })
        .run();

      const title = seq === 1 && session.title === "New session" ? firstText(message)?.trim().slice(0, 60) : undefined;
      tx.update(sessions)
        .set({ updatedAt: now, ...(title ? { title } : {}) })
        .where(eq(sessions.id, session.id))
        .run();
      return runId;
    });

  /**
   * Records how a run ended. Only a completed reply is saved: a cancelled or failed reply is partial,
   * and storing it would feed truncated text back to the model as if it were a full answer.
   */
  const finishRun = (runId: string, sessionId: string, status: RunStatus, reply?: UIMessage, error?: string) =>
    db.transaction((tx) => {
      const now = new Date();
      let assistantMessageId: string | undefined;
      if (status === "completed" && reply) {
        assistantMessageId = reply.id;
        tx.insert(messages)
          .values({
            id: reply.id,
            sessionId,
            seq: nextSeq(tx, sessionId),
            role: "assistant",
            parts: reply.parts,
            createdAt: now,
          })
          .run();
        tx.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run();
      }
      tx.update(runs)
        .set({ status, assistantMessageId, error, endedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.status, "running")))
        .run();
    });

  const api = new OpenAPIHono()
    .openapi(health, (c) => c.json({ ok: true as const }, 200))
    .openapi(listSessions, (c) => {
      const rows = db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
      return c.json(rows.map(toSessionJson), 200);
    })
    .openapi(createSession, async (c) => {
      const body = c.req.header("content-type")?.includes("application/json") ? c.req.valid("json") : {};
      const now = new Date();
      const row = { id: randomUUID(), title: body?.title ?? "New session", createdAt: now, updatedAt: now };
      db.insert(sessions).values(row).run();
      return c.json(toSessionJson(row), 201);
    })
    .openapi(listMessages, (c) => {
      const { id } = c.req.valid("param");
      if (!findSession(id)) return c.json({ error: "Session not found" }, 404);
      // Cast to the documented wire shape: hono's JSON typing recurses too deeply on the AI SDK's UIMessage type.
      return c.json(loadMessages(id) as unknown as z.infer<typeof Message>[], 200);
    })
    .openapi(chat, async (c) => {
      const { id } = c.req.valid("param");
      const session = findSession(id);
      if (!session) return c.json({ error: "Session not found" }, 404);

      let message: UIMessage;
      try {
        [message] = (await validateUIMessages({ messages: [c.req.valid("json").message] })) as [UIMessage];
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Invalid message" }, 400);
      }
      if (message.role !== "user") return c.json({ error: "Only user messages can be sent" }, 400);

      let languageModel: LanguageModel;
      try {
        languageModel = model();
      } catch (error) {
        return c.json({ error: errorText(error) }, 500);
      }

      let runId: string;
      try {
        runId = startRun(session, message);
      } catch (error) {
        if (error instanceof Conflict) return c.json({ error: error.message }, 409);
        throw error;
      }

      // Load history after claiming the run, so it cannot change underneath this request.
      const conversation = loadMessages(id);
      let modelMessages;
      try {
        modelMessages = await convertToModelMessages(conversation);
      } catch (error) {
        finishRun(runId, id, "failed", undefined, errorText(error));
        return c.json({ error: errorText(error) }, 500);
      }

      // A provider can report an error mid-stream and then close normally, which the SDK still calls
      // "completed". Remember the first error so such a run is recorded as failed.
      let streamError: unknown;
      // If the client disconnects or stops, abort the model call; the run is recorded as cancelled.
      const result = streamText({
        model: languageModel,
        instructions: INSTRUCTIONS,
        messages: modelMessages,
        abortSignal: c.req.raw.signal,
        onError: ({ error }) => {
          streamError ??= error;
        },
      });

      return result.toUIMessageStreamResponse({
        originalMessages: conversation,
        generateMessageId: randomUUID,
        onEnd: ({ responseMessage, outcome }) => {
          if (streamError !== undefined && outcome.status === "completed") {
            return finishRun(runId, id, "failed", undefined, errorText(streamError));
          }
          const status = runStatusFor(outcome);
          const error = outcome.status === "failed" ? errorText(outcome.error ?? streamError) : undefined;
          finishRun(runId, id, status, responseMessage, error);
        },
        // Provider errors (e.g. a missing API key) are shown to the learner; they are actionable.
        onError: errorText,
      });
    });

  api.doc("/doc", {
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
