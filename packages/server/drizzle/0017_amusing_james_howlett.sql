CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`session_id` text,
	`run_id` text,
	`seq` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_label` text NOT NULL,
	`model` text NOT NULL,
	`model_label` text,
	`effort` text,
	`billing` text NOT NULL,
	`input_tokens` integer,
	`input_no_cache_tokens` integer,
	`input_cache_read_tokens` integer,
	`input_cache_write_tokens` integer,
	`output_tokens` integer,
	`output_reasoning_tokens` integer,
	`reported_cost` real,
	`price` text,
	`estimated_cost` real,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_records_started_idx` ON `usage_records` (`started_at`);--> statement-breakpoint
CREATE INDEX `usage_records_run_idx` ON `usage_records` (`run_id`);