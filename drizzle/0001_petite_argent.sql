CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`max_bookmarks` integer NOT NULL,
	`max_history_entries` integer NOT NULL,
	`max_devices` integer NOT NULL,
	`operation_retention_days` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `plan_id` text DEFAULT 'free' NOT NULL;
--> statement-breakpoint
INSERT INTO `plans` (`id`, `max_bookmarks`, `max_history_entries`, `max_devices`, `operation_retention_days`) VALUES
	('free', 500, 10000, 3, 30),
	('pro', 10000, 100000, 10, 180);
