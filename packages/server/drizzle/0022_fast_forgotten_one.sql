CREATE TABLE `concept_session_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `concept_session_edges_edge_session_idx` ON `concept_session_edges` (`from_id`,`to_id`,`kind`,`session_id`) WHERE "concept_session_edges"."session_id" is not null;--> statement-breakpoint
CREATE INDEX `concept_session_edges_from_to_idx` ON `concept_session_edges` (`from_id`,`to_id`,`kind`);--> statement-breakpoint
CREATE INDEX `concept_session_edges_to_idx` ON `concept_session_edges` (`to_id`);--> statement-breakpoint
CREATE INDEX `concept_session_edges_session_idx` ON `concept_session_edges` (`session_id`);--> statement-breakpoint
CREATE TABLE `concept_session_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`concept_id` text NOT NULL,
	`session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `concept_session_sources_concept_session_idx` ON `concept_session_sources` (`concept_id`,`session_id`) WHERE "concept_session_sources"."session_id" is not null;--> statement-breakpoint
CREATE INDEX `concept_session_sources_concept_idx` ON `concept_session_sources` (`concept_id`);--> statement-breakpoint
CREATE INDEX `concept_session_sources_session_idx` ON `concept_session_sources` (`session_id`);