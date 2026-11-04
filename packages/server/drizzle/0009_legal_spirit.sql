ALTER TABLE `lesson_versions` ADD `changed_section_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `lesson_versions` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `syllabus_versions` ADD `source` text DEFAULT 'interview' NOT NULL;--> statement-breakpoint
ALTER TABLE `syllabus_versions` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `syllabus_versions` ADD `changed_topic_ids` text DEFAULT '[]' NOT NULL;