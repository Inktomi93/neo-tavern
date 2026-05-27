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
-- Hand-added: libSQL native ANN index (drizzle-kit can't emit libsql_vector_idx). BGE-M3 = 1024-dim.
-- Cross-character CORPUS search. Query: vector_top_k('character_embeddings_ann', vector32(?), k) JOIN character_embeddings ON rowid.
CREATE INDEX `character_embeddings_ann` ON `character_embeddings` (libsql_vector_idx(embedding));--> statement-breakpoint
DROP TABLE `embeddings`;