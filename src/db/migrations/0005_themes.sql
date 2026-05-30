CREATE TABLE `digest_theme_assignments` (
	`digest_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`cluster_idx` integer NOT NULL,
	`distance` real NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`digest_id`) REFERENCES `chat_digests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `digest_theme_owner_cluster_idx` ON `digest_theme_assignments` (`owner_id`,`cluster_idx`);--> statement-breakpoint
CREATE TABLE `theme_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`model` text NOT NULL,
	`cluster_idx` integer NOT NULL,
	`theme_name` text NOT NULL,
	`sub_themes` text,
	`description` text,
	`centroid` F32_BLOB(1024),
	`member_count` integer NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `theme_clusters_unq` ON `theme_clusters` (`owner_id`,`model`,`cluster_idx`);--> statement-breakpoint
ALTER TABLE `chat_digests` ADD `msg_mid_at` integer;