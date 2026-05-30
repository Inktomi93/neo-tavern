ALTER TABLE `chat_digests` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `chat_digests_content_idx` ON `chat_digests` (`owner_id`,`content_hash`);--> statement-breakpoint
ALTER TABLE `chat_segments` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `chat_segments_content_idx` ON `chat_segments` (`owner_id`,`content_hash`);