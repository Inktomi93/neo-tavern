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
-- Hand-added: libSQL native ANN index (drizzle-kit can't emit libsql_vector_idx). BGE-M3 = 1024-dim.
-- Cross-chat CORPUS search only (within-chat memory uses exact in-process cosine, scoped by chat_id).
-- Query with vector_top_k('chat_digests_ann', vector32(?), k) JOIN chat_digests ON rowid.
CREATE INDEX `chat_digests_ann` ON `chat_digests` (libsql_vector_idx(embedding));