ALTER TABLE `runs` ADD `continuation_of` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_continuation_once_idx` ON `runs` (`continuation_of`);