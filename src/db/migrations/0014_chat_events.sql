CREATE TABLE `chat_events` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chat_events_chat_idx` ON `chat_events` (`chat_id`,`at`);
