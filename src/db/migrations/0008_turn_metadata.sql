ALTER TABLE `messages` ADD `cache_creation_5m_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `cache_creation_1h_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `context_window` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `max_output_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `terminal_reason` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `api_error_status` integer;