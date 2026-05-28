CREATE TABLE `character_tags` (
	`tag_id` text NOT NULL,
	`character_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `character_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_tags` (
	`tag_id` text NOT NULL,
	`chat_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `chat_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `persona_tags` (
	`tag_id` text NOT NULL,
	`persona_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `persona_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `preset_tags` (
	`tag_id` text NOT NULL,
	`preset_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `preset_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preset_id`) REFERENCES `presets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `world_book_tags` (
	`tag_id` text NOT NULL,
	`world_book_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `world_book_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`world_book_id`) REFERENCES `world_books`(`id`) ON UPDATE no action ON DELETE cascade
);
