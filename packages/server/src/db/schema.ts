import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One row per AI SDK UIMessage; `parts` holds the message parts as JSON.
 * `seq` is the message's position within its session and defines conversation order.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    parts: text("parts", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("messages_session_seq_idx").on(t.sessionId, t.seq)],
);

export const runStatuses = ["running", "completed", "cancelled", "failed"] as const;
export type RunStatus = (typeof runStatuses)[number];

/**
 * One row per model generation. A session has at most one running run at a time,
 * enforced by the partial unique index. Only completed runs have a saved assistant message.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    assistantMessageId: text("assistant_message_id").references(() => messages.id, { onDelete: "set null" }),
    status: text("status", { enum: runStatuses }).notNull(),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("runs_session_idx").on(t.sessionId, t.startedAt),
    uniqueIndex("runs_one_running_per_session_idx")
      .on(t.sessionId)
      .where(sql`${t.status} = 'running'`),
  ],
);
