DROP INDEX `attempts_one_per_artifact_idx`;--> statement-breakpoint
ALTER TABLE `attempts` ADD `judge` text DEFAULT 'grader' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_one_per_artifact_idx` ON `attempts` (`artifact_id`,`judge`);