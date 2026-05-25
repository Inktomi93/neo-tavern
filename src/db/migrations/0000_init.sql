CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_hash_unique` ON `assets` (`hash`);--> statement-breakpoint
CREATE TABLE `cv_world_entries` (
	`cv_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`scope` text DEFAULT 'always',
	PRIMARY KEY(`cv_id`, `entry_id`)
);
--> statement-breakpoint
CREATE TABLE `character_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`personality` text,
	`scenario` text,
	`first_message` text,
	`example_messages` text,
	`system_prompt` text,
	`post_history_instructions` text,
	`alt_greetings` text,
	`tags` text,
	`creator_notes` text,
	`avatar_asset_id` text,
	`raw` text,
	`refinery_score` real,
	`refinery_analysis` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_versions_char_ver_unq` ON `character_versions` (`character_id`,`version`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`handle` text NOT NULL,
	`current_version_id` text,
	`imported_from` text,
	`import_hash` text,
	`starred` integer DEFAULT false,
	`archived` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `characters_handle_unique` ON `characters` (`handle`);--> statement-breakpoint
CREATE INDEX `characters_owner_idx` ON `characters` (`owner_id`);--> statement-breakpoint
CREATE TABLE `chat_world_entries` (
	`chat_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`scope` text DEFAULT 'always',
	`pinned` integer DEFAULT true,
	PRIMARY KEY(`chat_id`, `entry_id`)
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`character_version_id` text NOT NULL,
	`persona_id` text,
	`preset_id` text,
	`mode` text DEFAULT 'sdk' NOT NULL,
	`provider` text NOT NULL,
	`session_id` text,
	`parent_chat_id` text,
	`converted_at` integer,
	`forked_at` integer,
	`message_count` integer DEFAULT 0,
	`total_tokens_in` integer DEFAULT 0,
	`total_tokens_out` integer DEFAULT 0,
	`starred` integer DEFAULT false,
	`archived` integer DEFAULT false,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chats_owner_idx` ON `chats` (`owner_id`);--> statement-breakpoint
CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`model` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`seq` integer NOT NULL,
	`parent_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`model` text,
	`provider` text,
	`stop_reason` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`cost_usd` real,
	`preset_id` text,
	`raw_request` text,
	`raw_response` text,
	`created_at` integer NOT NULL,
	`edited_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_seq_unq` ON `messages` (`chat_id`,`seq`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`avatar_asset_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `presets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`session_id` text NOT NULL,
	`subpath` text,
	`seq` integer NOT NULL,
	`uuid` text,
	`type` text NOT NULL,
	`entry` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_entries_load_idx` ON `session_entries` (`session_id`,`subpath`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_entries_uuid_unq` ON `session_entries` (`session_id`,`subpath`,`uuid`) WHERE "session_entries"."uuid" is not null;--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `taggables` (
	`tag_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `entity_type`, `entity_id`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`source` text DEFAULT 'manual',
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`config` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE TABLE `world_books` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `world_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`world_book_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`legacy_keys` text,
	`enabled` integer DEFAULT true,
	`priority` integer DEFAULT 0,
	`metadata` text
);
