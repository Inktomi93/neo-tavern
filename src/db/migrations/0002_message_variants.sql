CREATE TABLE `message_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`idx` integer NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`provider` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`gen_started` integer,
	`gen_finished` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_variants_msg_idx_unq` ON `message_variants` (`message_id`,`idx`);--> statement-breakpoint
ALTER TABLE `messages` ADD `active_variant_idx` integer;