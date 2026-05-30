DROP INDEX `digest_theme_owner_cluster_idx`;--> statement-breakpoint
ALTER TABLE `digest_theme_assignments` ADD `level` text DEFAULT 'scene' NOT NULL;--> statement-breakpoint
CREATE INDEX `digest_theme_owner_cluster_idx` ON `digest_theme_assignments` (`owner_id`,`level`,`cluster_idx`);--> statement-breakpoint
DROP INDEX `theme_clusters_unq`;--> statement-breakpoint
ALTER TABLE `theme_clusters` ADD `level` text DEFAULT 'scene' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `theme_clusters_unq` ON `theme_clusters` (`owner_id`,`model`,`level`,`cluster_idx`);