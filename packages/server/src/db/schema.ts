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

/**
 * A learning artifact produced by an agent tool call (ADR-006). `spec` is the full, validated tool
 * input, including private fields such as a check's answer key; clients only ever see a view of it.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    spec: text("spec", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("artifacts_session_idx").on(t.sessionId, t.createdAt), uniqueIndex("artifacts_tool_call_idx").on(t.runId, t.toolCallId)],
);

/**
 * A learner's graded answer to a check artifact. One attempt per artifact (the grade reveals the
 * answer). `concept` and `correct` double as the first progress evidence (ADR-006).
 */
export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    answer: text("answer", { mode: "json" }).notNull(),
    grade: text("grade", { mode: "json" }).notNull(),
    correct: integer("correct", { mode: "boolean" }).notNull(),
    concept: text("concept"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("attempts_one_per_artifact_idx").on(t.artifactId), index("attempts_session_idx").on(t.sessionId, t.createdAt)],
);
