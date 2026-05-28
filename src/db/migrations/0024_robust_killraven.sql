CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`action` text NOT NULL,
	`domain` text NOT NULL,
	`entity_id` text,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `audit_logs_time_idx` ON `audit_logs` (`timestamp`);