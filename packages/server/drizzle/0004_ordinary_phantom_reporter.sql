CREATE TABLE `document_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`page` integer NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_chunks_document_seq_idx` ON `document_chunks` (`document_id`,`seq`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`filename` text NOT NULL,
	`kind` text NOT NULL,
	`byte_size` integer NOT NULL,
	`text_chars` integer NOT NULL,
	`page_count` integer NOT NULL,
	`pages_with_text` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_session_idx` ON `documents` (`session_id`,`created_at`);--> statement-breakpoint
-- Hand-written: Drizzle doesn't model FTS5. An external-content index over document_chunks, kept in sync by triggers, which also fire on foreign-key cascades.
CREATE VIRTUAL TABLE `document_chunks_fts` USING fts5(`text`, content=`document_chunks`, content_rowid=`id`, tokenize='porter unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `document_chunks_fts_insert` AFTER INSERT ON `document_chunks` BEGIN
	INSERT INTO `document_chunks_fts`(rowid, `text`) VALUES (new.`id`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `document_chunks_fts_delete` AFTER DELETE ON `document_chunks` BEGIN
	INSERT INTO `document_chunks_fts`(`document_chunks_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `document_chunks_fts_update` AFTER UPDATE ON `document_chunks` BEGIN
	INSERT INTO `document_chunks_fts`(`document_chunks_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
	INSERT INTO `document_chunks_fts`(rowid, `text`) VALUES (new.`id`, new.`text`);
END;
