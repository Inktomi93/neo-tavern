CREATE INDEX `character_tags_char_idx` ON `character_tags` (`character_id`);--> statement-breakpoint
CREATE INDEX `cv_world_entries_entry_idx` ON `cv_world_entries` (`entry_id`);--> statement-breakpoint
CREATE INDEX `chat_tags_chat_idx` ON `chat_tags` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chat_world_entries_entry_idx` ON `chat_world_entries` (`entry_id`);--> statement-breakpoint
CREATE INDEX `persona_tags_persona_idx` ON `persona_tags` (`persona_id`);--> statement-breakpoint
CREATE INDEX `preset_tags_preset_idx` ON `preset_tags` (`preset_id`);--> statement-breakpoint
CREATE INDEX `world_book_tags_book_idx` ON `world_book_tags` (`world_book_id`);--> statement-breakpoint
CREATE INDEX `world_entries_book_idx` ON `world_entries` (`world_book_id`);