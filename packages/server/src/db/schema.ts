import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** The learner renamed it, so automatic titling (a first message, the tutor's course title) leaves it alone. */
  titleSetByLearner: integer("title_set_by_learner", { mode: "boolean" }).notNull().default(false),
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
 * enforced by the partial unique index. Cancelled runs may save display-only partial text.
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
    /** A unique claim on the quiz reply this automatic run continues. No synthetic user message. */
    continuationOf: text("continuation_of"),
    assistantMessageId: text("assistant_message_id").references(() => messages.id, { onDelete: "set null" }),
    status: text("status", { enum: runStatuses }).notNull(),
    /** The model that ran, as "<provider>:<model-id>" (ADR-012). Null for runs before it was recorded. */
    model: text("model"),
    /** The reasoning effort it ran with; null leaves it to the model's default. */
    effort: text("effort"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("runs_continuation_once_idx").on(t.continuationOf),
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
  (t) => [uniqueIndex("attempts_one_per_artifact_idx").on(t.artifactId), index("attempts_session_idx").on(t.sessionId, t.createdAt), index("attempts_created_idx").on(t.createdAt)],
);

export const memoryStatuses = ["pending", "active", "superseded"] as const;

/** The model's inferences about the learner (ADR-009). Pending until the reply that wrote them completes. */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["goal", "preference", "misconception"] }).notNull(),
    text: text("text").notNull(),
    concept: text("concept"),
    basis: text("basis", { enum: ["wrong_answer", "chat"] }).notNull(),
    attemptId: text("attempt_id").references(() => attempts.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    status: text("status", { enum: memoryStatuses }).notNull(),
    /** The memory this one corrects, kept until this one is deleted. */
    replacesId: text("replaces_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("memories_status_idx").on(t.status, t.createdAt), index("memories_run_idx").on(t.runId)],
);

export const documentKinds = ["pdf", "pptx"] as const;

/**
 * A file the learner attached to a session (ADR-010). Only its extracted text is kept, never the file.
 * Extraction finishes before the row is written, so `status` is always "ready" for now.
 */
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    kind: text("kind", { enum: documentKinds }).notNull(),
    byteSize: integer("byte_size").notNull(),
    textChars: integer("text_chars").notNull(),
    pageCount: integer("page_count").notNull(),
    pagesWithText: integer("pages_with_text").notNull(),
    status: text("status", { enum: ["ready"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("documents_session_idx").on(t.sessionId, t.createdAt)],
);

/**
 * A piece of a document's text; `page` is its page or slide number and `seq` its position in the document.
 * The migration adds the document_chunks_fts FTS5 table, which triggers keep in sync with this one and
 * which relies on `id` being a stable rowid. Drizzle doesn't model it, so SessionStore queries it in SQL.
 */
export const documentChunks = sqliteTable(
  "document_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    page: integer("page").notNull(),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
  },
  (t) => [uniqueIndex("document_chunks_document_seq_idx").on(t.documentId, t.seq)],
);

export const courseStatuses = ["interviewing", "active", "complete"] as const;

/**
 * A course (ADR-011): one learning goal, taught in its own chat session. It starts with a placement
 * interview and becomes active once the AI has written its syllabus.
 */
export const courses = sqliteTable(
  "courses",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
    status: text("status", { enum: courseStatuses }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("courses_session_idx").on(t.sessionId)],
);

/**
 * One immutable version of a course's syllabus. `topics` is the ordered list of topics, each with a
 * server-assigned id that stays the same across versions, so lessons can refer to their topic.
 * `known` is what the AI said the learner already knows, labelled by source.
 */
export const syllabusVersions = sqliteTable(
  "syllabus_versions",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    topics: text("topics", { mode: "json" }).notNull(),
    known: text("known", { mode: "json" }).notNull(),
    /** Who made this version: the interview, the tutor on request (Change), or adaptive generation (ADR-011). */
    source: text("source", { enum: ["interview", "tutor", "adaptive", "undo"] }).notNull().default("interview"),
    /** For an adaptive change, the finished lesson whose results prompted it: at most one change per lesson. */
    triggerLessonId: text("trigger_lesson_id"),
    /** Why it changed, shown to the learner. Null for the first version. */
    reason: text("reason"),
    /** Ids of the topics this version added or changed, for highlighting. */
    changedTopicIds: text("changed_topic_ids", { mode: "json" }).notNull().default(sql`'[]'`),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("syllabus_versions_course_version_idx").on(t.courseId, t.version)],
);

export const lessonStatuses = ["generating", "ready", "failed", "finished"] as const;

/**
 * One lesson per syllabus topic (ADR-011). Generation runs in the lesson's own hidden session, so its
 * artifacts, attempts and model transcript use the existing tables. A finished lesson is frozen.
 */
export const lessons = sqliteTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull(),
    topicTitle: text("topic_title").notNull(),
    /** The topic's position in the syllabus when the lesson started. */
    position: integer("position").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    status: text("status", { enum: lessonStatuses }).notNull(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("lessons_course_topic_idx").on(t.courseId, t.topicId), uniqueIndex("lessons_session_idx").on(t.sessionId)],
);

/** An immutable lesson section: prose, or a reference to an artifact. Versions list sections by id. */
export const lessonSections = sqliteTable(
  "lesson_sections",
  {
    id: text("id").primaryKey(),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["prose", "artifact"] }).notNull(),
    title: text("title").notNull(),
    markdown: text("markdown"),
    artifactId: text("artifact_id").references(() => artifacts.id, { onDelete: "cascade" }),
    /** Sections of the previous lesson this one revisits, by id, so the page can link back to them. */
    revisits: text("revisits", { mode: "json" }).notNull().default(sql`'[]'`),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("lesson_sections_lesson_idx").on(t.lessonId), uniqueIndex("lesson_sections_artifact_idx").on(t.artifactId)],
);

/**
 * A version of a lesson: its outline and the ordered ids of its sections. Version 1 grows while it is
 * generated; later versions (Change, ADR-011) are new rows, so attempts stay with what the learner saw.
 */
export const lessonVersions = sqliteTable(
  "lesson_versions",
  {
    id: text("id").primaryKey(),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    outline: text("outline", { mode: "json" }).notNull(),
    sectionIds: text("section_ids", { mode: "json" }).notNull(),
    /** Ids of the sections this version added or changed, for highlighting. Empty for version 1. */
    changedSectionIds: text("changed_section_ids", { mode: "json" }).notNull().default(sql`'[]'`),
    /** Why the tutor changed it. Null for version 1. */
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("lesson_versions_lesson_version_idx").on(t.lessonId, t.version)],
);

/** App-wide settings as JSON values by key, such as the current model selection (ADR-012). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** One imported Obsidian vault (ADR-014). Importing again replaces its notes with the new snapshot. */
export const vaultImports = sqliteTable(
  "vault_imports",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    source: text("source", { enum: ["obsidian"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("vault_imports_name_idx").on(t.name)],
);

/**
 * A Markdown note from an imported vault, written only by the import (ADR-014). `hash` is the SHA-256 of its text,
 * so a re-import skips unchanged files. `titleKey` and `aliases` (already normalised) resolve `[[links]]`.
 */
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => vaultImports.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    title: text("title").notNull(),
    titleKey: text("title_key").notNull(),
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull(),
    body: text("body").notNull(),
    hash: text("hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("notes_import_path_idx").on(t.importId, t.path), index("notes_import_title_idx").on(t.importId, t.titleKey)],
);

/**
 * A piece of a note's text under its heading path (`Heading > Subheading`). The migration adds the note_chunks_fts
 * FTS5 table, kept in sync by triggers, which relies on `id` being a stable rowid, as for document chunks.
 */
export const noteChunks = sqliteTable(
  "note_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    heading: text("heading"),
    text: text("text").notNull(),
  },
  (t) => [uniqueIndex("note_chunks_note_seq_idx").on(t.noteId, t.seq)],
);

/** A `[[link]]` or `![[embed]]` as written, without its heading or display text. Resolved to a note when read. */
export const noteLinks = sqliteTable(
  "note_links",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    kind: text("kind", { enum: ["link", "embed"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.target, t.kind] })],
);

/** A tag from a note's text or frontmatter, lower-cased and without its `#`. */
export const noteTags = sqliteTable(
  "note_tags",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.tag] }), index("note_tags_tag_idx").on(t.tag)],
);
