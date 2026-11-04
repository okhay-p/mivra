ALTER TABLE `lesson_sections` ADD `revisits` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `syllabus_versions` ADD `trigger_lesson_id` text;