import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { messages, sessions } from "./db/schema.js";

const INSTRUCTIONS =
  "You are Mivra, a patient tutor. Explain concepts step by step, check the learner's understanding, and adapt to what they already know.";

export interface AppDeps {
  db: Db;
  model: () => LanguageModel;
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
    200: { description: "Messages in order", content: { "application/json": { schema: z.array(Message) } } },
    404: { description: "Unknown session", content: { "application/json": { schema: ErrorBody } } },
  },
});

const chat = createRoute({
  method: "post",
  path: "/sessions/{id}/chat",
  description:
    "Append a user message and stream the assistant reply as an AI SDK UI message stream (Server-Sent Events). The server owns history; send only the new message.",
  request: {
    params: SessionParams,
    body: { content: { "application/json": { schema: z.object({ message: Message }) } } },
  },
  responses: {
    200: { description: "UI message stream", content: { "text/event-stream": { schema: z.string() } } },
    400: { description: "Invalid message", content: { "application/json": { schema: ErrorBody } } },
    404: { description: "Unknown session", content: { "application/json": { schema: ErrorBody } } },
  },
});

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

export function createApp({ db, model }: AppDeps) {
  const loadMessages = (sessionId: string): UIMessage[] =>
    db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
      .all()
      .map((row) => ({ id: row.id, role: row.role, parts: row.parts as UIMessage["parts"] }));

  const saveMessage = (sessionId: string, message: UIMessage) => {
    const now = new Date();
    db.insert(messages)
      .values({ id: message.id, sessionId, role: message.role, parts: message.parts, createdAt: now })
      .onConflictDoUpdate({ target: messages.id, set: { parts: message.parts } })
      .run();
    db.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run();
  };

  const findSession = (id: string) => db.select().from(sessions).where(eq(sessions.id, id)).get();

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

      const history = loadMessages(id);
      if (history.length === 0 && session.title === "New session") {
        const title = firstText(message)?.trim().slice(0, 60);
        if (title) db.update(sessions).set({ title }).where(eq(sessions.id, id)).run();
      }
      saveMessage(id, message);
      const conversation = [...history, message];

      const result = streamText({
        model: model(),
        instructions: INSTRUCTIONS,
        messages: await convertToModelMessages(conversation),
      });

      return result.toUIMessageStreamResponse({
        originalMessages: conversation,
        generateMessageId: randomUUID,
        onEnd: ({ messages: updated }) => {
          const reply = updated.at(-1);
          if (reply && reply.role === "assistant") saveMessage(id, reply);
        },
        onError: (error) => (error instanceof Error ? error.message : "The model request failed"),
      });
    });

  api.doc("/doc", { openapi: "3.1.0", info: { title: "Mivra API", version: "0.0.0" } });

  return new OpenAPIHono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
