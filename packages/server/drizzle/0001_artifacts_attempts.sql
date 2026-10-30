CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`spec` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_session_idx` ON `artifacts` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_tool_call_idx` ON `artifacts` (`run_id`,`tool_call_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`session_id` text NOT NULL,
	`answer` text NOT NULL,
	`grade` text NOT NULL,
	`correct` integer NOT NULL,
	`concept` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_one_per_artifact_idx` ON `attempts` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `attempts_session_idx` ON `attempts` (`session_id`,`created_at`);