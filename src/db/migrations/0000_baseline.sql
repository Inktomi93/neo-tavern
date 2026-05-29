CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_hash_unique` ON `assets` (`hash`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`action` text NOT NULL,
	`domain` text NOT NULL,
	`entity_id` text,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `audit_logs_time_idx` ON `audit_logs` (`timestamp`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`user_agent` text,
	`label` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_credentials_user_provider_unq` ON `user_credentials` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `character_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`personality` text,
	`scenario` text,
	`greetings` text,
	`example_messages` text,
	`system_prompt` text,
	`post_history_instructions` text,
	`tags` text,
	`creator_notes` text,
	`avatar_asset_id` text,
	`raw` text,
	`refinery_score` real,
	`refinery_analysis` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`avatar_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
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
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `characters_handle_unique` ON `characters` (`handle`);--> statement-breakpoint
CREATE INDEX `characters_owner_idx` ON `characters` (`owner_id`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`avatar_asset_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`avatar_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
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
CREATE INDEX `chat_events_chat_idx` ON `chat_events` (`chat_id`,`at`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`character_version_id` text NOT NULL,
	`persona_id` text,
	`pinned_persona_id` text,
	`preset_version_id` text,
	`api` text DEFAULT 'agent-sdk' NOT NULL,
	`source` text DEFAULT 'max-pro-sub' NOT NULL,
	`model` text,
	`session_id` text,
	`compact_summary` text,
	`compacted_at_seq` integer,
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
	FOREIGN KEY (`pinned_persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`preset_version_id`) REFERENCES `preset_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chats_owner_idx` ON `chats` (`owner_id`);--> statement-breakpoint
CREATE TABLE `message_variants` (
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
CREATE UNIQUE INDEX `message_variants_msg_idx_unq` ON `message_variants` (`message_id`,`idx`);--> statement-breakpoint
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
	`finish_reason` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`cache_creation_5m_tokens` integer,
	`cache_creation_1h_tokens` integer,
	`cost_usd` real,
	`context_window` integer,
	`max_output_tokens` integer,
	`ttft_ms` integer,
	`terminal_reason` text,
	`api_error_status` integer,
	`preset_version_id` text,
	`reasoning_effort` text,
	`gen_started` integer,
	`gen_finished` integer,
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
CREATE UNIQUE INDEX `messages_chat_seq_unq` ON `messages` (`chat_id`,`seq`);--> statement-breakpoint
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
CREATE TABLE `presets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`current_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `preset_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `character_embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`character_version_id` text NOT NULL,
	`model` text NOT NULL,
	`embedding` F32_BLOB(1024),
	`hub_score` real,
	`source_text` text,
	`tokens` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_version_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_embeddings_character_model_unq` ON `character_embeddings` (`character_id`,`model`);--> statement-breakpoint
CREATE INDEX `character_embeddings_owner_idx` ON `character_embeddings` (`owner_id`);--> statement-breakpoint
CREATE INDEX `character_embeddings_ann` ON `character_embeddings` (libsql_vector_idx(embedding));--> statement-breakpoint
CREATE TABLE `chat_digests` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`character_version_id` text NOT NULL,
	`tier` integer DEFAULT 0 NOT NULL,
	`block_idx` integer NOT NULL,
	`seq_start` integer NOT NULL,
	`seq_end` integer NOT NULL,
	`text` text NOT NULL,
	`topic_anchor` text,
	`keywords` text,
	`model` text NOT NULL,
	`summarizer_model` text,
	`embedding` F32_BLOB(1024),
	`hub_score` real,
	`tokens` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_version_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_digests_chat_tier_block_unq` ON `chat_digests` (`chat_id`,`tier`,`block_idx`);--> statement-breakpoint
CREATE INDEX `chat_digests_owner_idx` ON `chat_digests` (`owner_id`);--> statement-breakpoint
CREATE INDEX `chat_digests_ann` ON `chat_digests` (libsql_vector_idx(embedding));--> statement-breakpoint
CREATE TABLE `chat_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`character_version_id` text NOT NULL,
	`block_idx` integer NOT NULL,
	`seq_start` integer NOT NULL,
	`seq_end` integer NOT NULL,
	`text` text NOT NULL,
	`model` text NOT NULL,
	`embedding` F32_BLOB(1024),
	`hub_score` real,
	`tokens` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_version_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_segments_chat_block_unq` ON `chat_segments` (`chat_id`,`block_idx`);--> statement-breakpoint
CREATE INDEX `chat_segments_owner_idx` ON `chat_segments` (`owner_id`);--> statement-breakpoint
CREATE INDEX `chat_segments_ann` ON `chat_segments` (libsql_vector_idx(embedding));--> statement-breakpoint
CREATE TABLE `image_embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`model` text NOT NULL,
	`embedding` F32_BLOB(1152),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_embeddings_asset_model_unq` ON `image_embeddings` (`asset_id`,`model`);--> statement-breakpoint
CREATE INDEX `image_embeddings_ann` ON `image_embeddings` (libsql_vector_idx(embedding));--> statement-breakpoint
CREATE TABLE `session_entries` (
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
CREATE INDEX `session_entries_load_idx` ON `session_entries` (`session_id`,`subpath`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_entries_uuid_unq` ON `session_entries` (`session_id`,`subpath`,`uuid`) WHERE "session_entries"."uuid" is not null;--> statement-breakpoint
CREATE TABLE `character_tags` (
	`tag_id` text NOT NULL,
	`character_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `character_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `character_tags_char_idx` ON `character_tags` (`character_id`);--> statement-breakpoint
CREATE TABLE `chat_tags` (
	`tag_id` text NOT NULL,
	`chat_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `chat_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_tags_chat_idx` ON `chat_tags` (`chat_id`);--> statement-breakpoint
CREATE TABLE `persona_tags` (
	`tag_id` text NOT NULL,
	`persona_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `persona_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `persona_tags_persona_idx` ON `persona_tags` (`persona_id`);--> statement-breakpoint
CREATE TABLE `preset_tags` (
	`tag_id` text NOT NULL,
	`preset_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `preset_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preset_id`) REFERENCES `presets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `preset_tags_preset_idx` ON `preset_tags` (`preset_id`);--> statement-breakpoint
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
CREATE TABLE `world_book_tags` (
	`tag_id` text NOT NULL,
	`world_book_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `world_book_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`world_book_id`) REFERENCES `world_books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `world_book_tags_book_idx` ON `world_book_tags` (`world_book_id`);--> statement-breakpoint
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
	`external_id` text,
	`display_name` text,
	`enabled` integer DEFAULT true NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_id_unique` ON `users` (`external_id`);--> statement-breakpoint
CREATE TABLE `cv_world_entries` (
	`cv_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`scope` text DEFAULT 'always',
	PRIMARY KEY(`cv_id`, `entry_id`),
	FOREIGN KEY (`cv_id`) REFERENCES `character_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `world_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cv_world_entries_entry_idx` ON `cv_world_entries` (`entry_id`);--> statement-breakpoint
CREATE TABLE `chat_world_entries` (
	`chat_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`scope` text DEFAULT 'always',
	`pinned` integer DEFAULT true,
	PRIMARY KEY(`chat_id`, `entry_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `world_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_world_entries_entry_idx` ON `chat_world_entries` (`entry_id`);--> statement-breakpoint
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
	`metadata` text,
	FOREIGN KEY (`world_book_id`) REFERENCES `world_books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `world_entries_book_idx` ON `world_entries` (`world_book_id`);