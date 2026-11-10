CREATE TABLE `concept_edges` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`note_id` text NOT NULL,
	PRIMARY KEY(`from_id`, `to_id`, `kind`, `note_id`),
	FOREIGN KEY (`from_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `concept_edges_note_idx` ON `concept_edges` (`note_id`);--> statement-breakpoint
CREATE INDEX `concept_edges_to_idx` ON `concept_edges` (`to_id`);--> statement-breakpoint
CREATE TABLE `concept_sources` (
	`concept_id` text NOT NULL,
	`note_id` text NOT NULL,
	PRIMARY KEY(`concept_id`, `note_id`),
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `concept_sources_note_idx` ON `concept_sources` (`note_id`);--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `concepts_key_idx` ON `concepts` (`key`);--> statement-breakpoint
CREATE TABLE `memory_sources` (
	`memory_id` text NOT NULL,
	`note_id` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`memory_id`, `note_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_sources_note_idx` ON `memory_sources` (`note_id`);--> statement-breakpoint
ALTER TABLE `memories` ADD `note_id` text REFERENCES notes(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `memories_note_idx` ON `memories` (`note_id`);--> statement-breakpoint
ALTER TABLE `notes` ADD `distilled_hash` text;