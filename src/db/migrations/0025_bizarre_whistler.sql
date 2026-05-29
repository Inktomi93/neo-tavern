ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
-- Backfill: existing rows predate roles. Single-user today → the one row is the owner, so promote
-- to admin (the column default 'user' applies to all FUTURE inserts; ensureUser sets the owner to
-- admin going forward via DEFAULT_USER_HANDLE). Safe no-op on a fresh DB with no rows.
UPDATE `users` SET `role` = 'admin';