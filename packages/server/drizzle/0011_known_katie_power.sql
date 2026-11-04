CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `model` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `effort` text;