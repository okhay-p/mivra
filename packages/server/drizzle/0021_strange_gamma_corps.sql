ALTER TABLE `note_links` ADD `target_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `note_links_target_key_idx` ON `note_links` (`target_key`);