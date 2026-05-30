CREATE TABLE `character_summaries` (
	`character_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`character_version_id` text NOT NULL,
	`genre` text,
	`sub_genres` text,
	`tone` text,
	`setting` text,
	`tags` text,
	`elevator_pitch` text,
	`overview` text,
	`model` text NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `character_summaries_owner_genre_idx` ON `character_summaries` (`owner_id`,`genre`);--> statement-breakpoint
CREATE INDEX `character_summaries_owner_tone_idx` ON `character_summaries` (`owner_id`,`tone`);