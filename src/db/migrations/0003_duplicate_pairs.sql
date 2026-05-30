CREATE TABLE `duplicate_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id_a` text NOT NULL,
	`entity_id_b` text NOT NULL,
	`similarity` real NOT NULL,
	`csls_score` real,
	`relation` text DEFAULT 'duplicate' NOT NULL,
	`model` text NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `duplicate_pairs_unq` ON `duplicate_pairs` (`owner_id`,`entity_type`,`entity_id_a`,`entity_id_b`);--> statement-breakpoint
CREATE INDEX `duplicate_pairs_lookup_idx` ON `duplicate_pairs` (`owner_id`,`entity_type`,`similarity`);