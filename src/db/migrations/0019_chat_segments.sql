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
-- Hand-added: libSQL native ANN index (drizzle-kit can't emit libsql_vector_idx). BGE-M3 = 1024-dim.
-- Cross-chat corpus search (the raw-verbatim half of the hybrid); owner-scoped via the WHERE.
-- Query with vector_top_k('chat_segments_ann', vector32(?), k) JOIN chat_segments ON rowid.
CREATE INDEX `chat_segments_ann` ON `chat_segments` (libsql_vector_idx(embedding));