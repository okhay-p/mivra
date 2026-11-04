CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courses_session_idx` ON `courses` (`session_id`);--> statement-breakpoint
CREATE TABLE `syllabus_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`version` integer NOT NULL,
	`topics` text NOT NULL,
	`known` text NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `syllabus_versions_course_version_idx` ON `syllabus_versions` (`course_id`,`version`);