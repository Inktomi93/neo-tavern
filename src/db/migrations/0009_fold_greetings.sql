ALTER TABLE `character_versions` ADD `greetings` text;--> statement-breakpoint
ALTER TABLE `character_versions` DROP COLUMN `first_message`;--> statement-breakpoint
ALTER TABLE `character_versions` DROP COLUMN `alt_greetings`;