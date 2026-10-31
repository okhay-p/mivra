CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`concept` text,
	`basis` text NOT NULL,
	`attempt_id` text,
	`session_id` text,
	`run_id` text,
	`status` text NOT NULL,
	`replaces_id` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_status_idx` ON `memories` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `memories_run_idx` ON `memories` (`run_id`);