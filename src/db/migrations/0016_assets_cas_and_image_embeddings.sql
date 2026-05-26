-- Content-addressed asset store. The blob locator IS the hash (cas.blobPath), so the stored
-- `path` column is dropped — the row is metadata only (bytes live on the mounted volume). Then
-- wire the avatar foreign keys that 0007 skipped (assets were unused then), and add the SigLIP-2
-- image-vector landing table (a SEPARATE dim/space from the 1024-dim text `embeddings`).
ALTER TABLE `assets` DROP COLUMN `path`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_personas` (
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
INSERT INTO `__new_personas`("id", "owner_id", "name", "description", "avatar_asset_id", "metadata", "created_at") SELECT "id", "owner_id", "name", "description", "avatar_asset_id", "metadata", "created_at" FROM `personas`;--> statement-breakpoint
DROP TABLE `personas`;--> statement-breakpoint
ALTER TABLE `__new_personas` RENAME TO `personas`;--> statement-breakpoint
CREATE TABLE `__new_character_versions` (
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
INSERT INTO `__new_character_versions`("id", "character_id", "version", "name", "description", "personality", "scenario", "greetings", "example_messages", "system_prompt", "post_history_instructions", "tags", "creator_notes", "avatar_asset_id", "raw", "refinery_score", "refinery_analysis", "created_at") SELECT "id", "character_id", "version", "name", "description", "personality", "scenario", "greetings", "example_messages", "system_prompt", "post_history_instructions", "tags", "creator_notes", "avatar_asset_id", "raw", "refinery_score", "refinery_analysis", "created_at" FROM `character_versions`;--> statement-breakpoint
DROP TABLE `character_versions`;--> statement-breakpoint
ALTER TABLE `__new_character_versions` RENAME TO `character_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `character_versions_char_ver_unq` ON `character_versions` (`character_id`,`version`);--> statement-breakpoint
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
-- Hand-added: libSQL native ANN index (drizzle-kit can't emit libsql_vector_idx). SigLIP-2
-- so400m = 1152-dim. Query with vector_top_k('image_embeddings_ann', vector32(?), k) JOIN ... ON rowid.
CREATE INDEX `image_embeddings_ann` ON `image_embeddings` (libsql_vector_idx(embedding));
