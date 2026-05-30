CREATE TABLE `character_keyword_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`character_id` text NOT NULL,
	`keyword` text NOT NULL,
	`count` integer NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `char_kw_unq` ON `character_keyword_profiles` (`owner_id`,`character_id`,`keyword`);--> statement-breakpoint
CREATE INDEX `char_kw_char_idx` ON `character_keyword_profiles` (`owner_id`,`character_id`,`count`);--> statement-breakpoint
CREATE INDEX `char_kw_kw_idx` ON `character_keyword_profiles` (`owner_id`,`keyword`,`count`);--> statement-breakpoint
CREATE TABLE `keyword_cooccurrence` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`keyword_a` text NOT NULL,
	`keyword_b` text NOT NULL,
	`count` integer NOT NULL,
	`character_ids` text,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keyword_cooc_unq` ON `keyword_cooccurrence` (`owner_id`,`keyword_a`,`keyword_b`);--> statement-breakpoint
CREATE INDEX `keyword_cooc_a_idx` ON `keyword_cooccurrence` (`owner_id`,`keyword_a`,`count`);--> statement-breakpoint
CREATE INDEX `keyword_cooc_b_idx` ON `keyword_cooccurrence` (`owner_id`,`keyword_b`,`count`);