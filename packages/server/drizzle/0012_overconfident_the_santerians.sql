CREATE TABLE `note_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` text NOT NULL,
	`seq` integer NOT NULL,
	`heading` text,
	`text` text NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_chunks_note_seq_idx` ON `note_chunks` (`note_id`,`seq`);--> statement-breakpoint
CREATE TABLE `note_links` (
	`note_id` text NOT NULL,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`note_id`, `target`, `kind`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `note_tags` (
	`note_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`note_id`, `tag`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_tags_tag_idx` ON `note_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`title_key` text NOT NULL,
	`aliases` text NOT NULL,
	`body` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `vault_imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notes_import_path_idx` ON `notes` (`import_id`,`path`);--> statement-breakpoint
CREATE INDEX `notes_import_title_idx` ON `notes` (`import_id`,`title_key`);--> statement-breakpoint
CREATE TABLE `vault_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_imports_name_idx` ON `vault_imports` (`name`);--> statement-breakpoint
-- Hand-written: Drizzle doesn't model FTS5. An external-content index over note_chunks, kept in sync by triggers, which also fire on foreign-key cascades.
CREATE VIRTUAL TABLE `note_chunks_fts` USING fts5(`heading`, `text`, content=`note_chunks`, content_rowid=`id`, tokenize='porter unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `note_chunks_fts_insert` AFTER INSERT ON `note_chunks` BEGIN
	INSERT INTO `note_chunks_fts`(rowid, `heading`, `text`) VALUES (new.`id`, new.`heading`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `note_chunks_fts_delete` AFTER DELETE ON `note_chunks` BEGIN
	INSERT INTO `note_chunks_fts`(`note_chunks_fts`, rowid, `heading`, `text`) VALUES ('delete', old.`id`, old.`heading`, old.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `note_chunks_fts_update` AFTER UPDATE ON `note_chunks` BEGIN
	INSERT INTO `note_chunks_fts`(`note_chunks_fts`, rowid, `heading`, `text`) VALUES ('delete', old.`id`, old.`heading`, old.`text`);
	INSERT INTO `note_chunks_fts`(rowid, `heading`, `text`) VALUES (new.`id`, new.`heading`, new.`text`);
END;
