CREATE TABLE `preset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`preset_id` text NOT NULL,
	`version` integer NOT NULL,
	`config` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`preset_id`) REFERENCES `presets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preset_versions_preset_ver_unq` ON `preset_versions` (`preset_id`,`version`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`character_version_id` text NOT NULL,
	`persona_id` text,
	`preset_version_id` text,
	`mode` text DEFAULT 'sdk' NOT NULL,
	`provider` text NOT NULL,
	`session_id` text,
	`parent_chat_id` text,
	`converted_at` integer,
	`forked_at` integer,
	`imported_from` text,
	`import_hash` text,
	`message_count` integer DEFAULT 0,
	`total_tokens_in` integer DEFAULT 0,
	`total_tokens_out` integer DEFAULT 0,
	`starred` integer DEFAULT false,
	`archived` integer DEFAULT false,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_version_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`preset_version_id`) REFERENCES `preset_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_chats`("id", "owner_id", "title", "character_version_id", "persona_id", "mode", "provider", "session_id", "parent_chat_id", "converted_at", "forked_at", "imported_from", "import_hash", "message_count", "total_tokens_in", "total_tokens_out", "starred", "archived", "metadata", "created_at", "updated_at") SELECT "id", "owner_id", "title", "character_version_id", "persona_id", "mode", "provider", "session_id", "parent_chat_id", "converted_at", "forked_at", "imported_from", "import_hash", "message_count", "total_tokens_in", "total_tokens_out", "starred", "archived", "metadata", "created_at", "updated_at" FROM `chats`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
ALTER TABLE `__new_chats` RENAME TO `chats`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chats_owner_idx` ON `chats` (`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_message_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`idx` integer NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`provider` text,
	`reasoning_effort` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`gen_started` integer,
	`gen_finished` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_message_variants`("id", "message_id", "idx", "content", "model", "provider", "tokens_in", "tokens_out", "gen_started", "gen_finished", "created_at") SELECT "id", "message_id", "idx", "content", "model", "provider", "tokens_in", "tokens_out", "gen_started", "gen_finished", "created_at" FROM `message_variants`;--> statement-breakpoint
DROP TABLE `message_variants`;--> statement-breakpoint
ALTER TABLE `__new_message_variants` RENAME TO `message_variants`;--> statement-breakpoint
CREATE UNIQUE INDEX `message_variants_msg_idx_unq` ON `message_variants` (`message_id`,`idx`);--> statement-breakpoint
CREATE TABLE `__new_messages` (
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
	`preset_version_id` text,
	`reasoning_effort` text,
	`raw_request` text,
	`raw_response` text,
	`active_variant_idx` integer,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`preset_version_id`) REFERENCES `preset_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "chat_id", "seq", "parent_id", "role", "content", "tool_calls", "model", "provider", "stop_reason", "tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens", "cost_usd", "raw_request", "raw_response", "active_variant_idx", "created_at", "edited_at") SELECT "id", "chat_id", "seq", "parent_id", "role", "content", "tool_calls", "model", "provider", "stop_reason", "tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens", "cost_usd", "raw_request", "raw_response", "active_variant_idx", "created_at", "edited_at" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_seq_unq` ON `messages` (`chat_id`,`seq`);--> statement-breakpoint
ALTER TABLE `presets` ADD `current_version_id` text REFERENCES preset_versions(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `presets` DROP COLUMN `config`;--> statement-breakpoint
ALTER TABLE `presets` DROP COLUMN `schema_version`;--> statement-breakpoint
CREATE TABLE `__new_cv_world_entries` (
	`cv_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`scope` text DEFAULT 'always',
	PRIMARY KEY(`cv_id`, `entry_id`),
	FOREIGN KEY (`cv_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `world_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_cv_world_entries`("cv_id", "entry_id", "scope") SELECT "cv_id", "entry_id", "scope" FROM `cv_world_entries`;--> statement-breakpoint
DROP TABLE `cv_world_entries`;--> statement-breakpoint
ALTER TABLE `__new_cv_world_entries` RENAME TO `cv_world_entries`;--> statement-breakpoint
CREATE TABLE `__new_character_versions` (
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
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_character_versions`("id", "character_id", "version", "name", "description", "personality", "scenario", "first_message", "example_messages", "system_prompt", "post_history_instructions", "alt_greetings", "tags", "creator_notes", "avatar_asset_id", "raw", "refinery_score", "refinery_analysis", "created_at") SELECT "id", "character_id", "version", "name", "description", "personality", "scenario", "first_message", "example_messages", "system_prompt", "post_history_instructions", "alt_greetings", "tags", "creator_notes", "avatar_asset_id", "raw", "refinery_score", "refinery_analysis", "created_at" FROM `character_versions`;--> statement-breakpoint
DROP TABLE `character_versions`;--> statement-breakpoint
ALTER TABLE `__new_character_versions` RENAME TO `character_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `character_versions_char_ver_unq` ON `character_versions` (`character_id`,`version`);--> statement-breakpoint
CREATE TABLE `__new_characters` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`handle` text NOT NULL,
	`current_version_id` text,
	`imported_from` text,
	`import_hash` text,
	`starred` integer DEFAULT false,
	`archived` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_characters`("id", "owner_id", "handle", "current_version_id", "imported_from", "import_hash", "starred", "archived", "created_at") SELECT "id", "owner_id", "handle", "current_version_id", "imported_from", "import_hash", "starred", "archived", "created_at" FROM `characters`;--> statement-breakpoint
DROP TABLE `characters`;--> statement-breakpoint
ALTER TABLE `__new_characters` RENAME TO `characters`;--> statement-breakpoint
CREATE UNIQUE INDEX `characters_handle_unique` ON `characters` (`handle`);--> statement-breakpoint
CREATE INDEX `characters_owner_idx` ON `characters` (`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_chat_world_entries` (
	`chat_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`scope` text DEFAULT 'always',
	`pinned` integer DEFAULT true,
	PRIMARY KEY(`chat_id`, `entry_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `world_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_chat_world_entries`("chat_id", "entry_id", "scope", "pinned") SELECT "chat_id", "entry_id", "scope", "pinned" FROM `chat_world_entries`;--> statement-breakpoint
DROP TABLE `chat_world_entries`;--> statement-breakpoint
ALTER TABLE `__new_chat_world_entries` RENAME TO `chat_world_entries`;--> statement-breakpoint
CREATE TABLE `__new_session_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`session_id` text NOT NULL,
	`subpath` text,
	`seq` integer NOT NULL,
	`uuid` text,
	`type` text NOT NULL,
	`entry` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_session_entries`("id", "chat_id", "session_id", "subpath", "seq", "uuid", "type", "entry", "created_at") SELECT "id", "chat_id", "session_id", "subpath", "seq", "uuid", "type", "entry", "created_at" FROM `session_entries`;--> statement-breakpoint
DROP TABLE `session_entries`;--> statement-breakpoint
ALTER TABLE `__new_session_entries` RENAME TO `session_entries`;--> statement-breakpoint
CREATE INDEX `session_entries_load_idx` ON `session_entries` (`session_id`,`subpath`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_entries_uuid_unq` ON `session_entries` (`session_id`,`subpath`,`uuid`) WHERE "session_entries"."uuid" is not null;--> statement-breakpoint
CREATE TABLE `__new_taggables` (
	`tag_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `entity_type`, `entity_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_taggables`("tag_id", "entity_type", "entity_id") SELECT "tag_id", "entity_type", "entity_id" FROM `taggables`;--> statement-breakpoint
DROP TABLE `taggables`;--> statement-breakpoint
ALTER TABLE `__new_taggables` RENAME TO `taggables`;--> statement-breakpoint
CREATE TABLE `__new_world_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`world_book_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`legacy_keys` text,
	`enabled` integer DEFAULT true,
	`priority` integer DEFAULT 0,
	`metadata` text,
	FOREIGN KEY (`world_book_id`) REFERENCES `world_books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_world_entries`("id", "world_book_id", "title", "content", "legacy_keys", "enabled", "priority", "metadata") SELECT "id", "world_book_id", "title", "content", "legacy_keys", "enabled", "priority", "metadata" FROM `world_entries`;--> statement-breakpoint
DROP TABLE `world_entries`;--> statement-breakpoint
ALTER TABLE `__new_world_entries` RENAME TO `world_entries`;