CREATE TABLE `lesson_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`markdown` text,
	`artifact_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lesson_sections_lesson_idx` ON `lesson_sections` (`lesson_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_sections_artifact_idx` ON `lesson_sections` (`artifact_id`);--> statement-breakpoint
CREATE TABLE `lesson_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`version` integer NOT NULL,
	`outline` text NOT NULL,
	`section_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_versions_lesson_version_idx` ON `lesson_versions` (`lesson_id`,`version`);--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`topic_title` text NOT NULL,
	`position` integer NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lessons_course_topic_idx` ON `lessons` (`course_id`,`topic_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lessons_session_idx` ON `lessons` (`session_id`);