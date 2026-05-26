ALTER TABLE `chats` ADD `api` text DEFAULT 'agent-sdk' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `source` text DEFAULT 'max-pro-sub' NOT NULL;--> statement-breakpoint
UPDATE `chats` SET `api` = 'responses', `source` = 'openrouter' WHERE `mode` = 'raw';--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `mode`;--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `provider`;
