CREATE TABLE `bookmarks` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`favicon` text NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`server_revision` integer NOT NULL,
	`server_updated_at` integer NOT NULL,
	`client_updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`user_id`, `item_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmarks_user_url_unique` ON `bookmarks` (`user_id`,`url`);--> statement-breakpoint
CREATE INDEX `bookmarks_user_updated_idx` ON `bookmarks` (`user_id`,`server_revision`);--> statement-breakpoint
CREATE TABLE `deletion_event_devices` (
	`deletion_id` integer NOT NULL,
	`device_id` text NOT NULL,
	`acknowledged_at` integer,
	PRIMARY KEY(`deletion_id`, `device_id`)
);
--> statement-breakpoint
CREATE INDEX `deletion_event_devices_device_idx` ON `deletion_event_devices` (`device_id`);--> statement-breakpoint
CREATE TABLE `deletion_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`client_updated_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`server_revision` integer NOT NULL,
	`server_deleted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deletion_events_user_deleted_idx` ON `deletion_events` (`user_id`,`server_revision`);--> statement-breakpoint
CREATE INDEX `deletion_events_user_item_idx` ON `deletion_events` (`user_id`,`kind`,`item_id`);--> statement-breakpoint
CREATE TABLE `history_entries` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`favicon` text NOT NULL,
	`visited_at` integer NOT NULL,
	`server_revision` integer NOT NULL,
	`server_updated_at` integer NOT NULL,
	`client_updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`user_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `history_entries_user_updated_idx` ON `history_entries` (`user_id`,`server_revision`);--> statement-breakpoint
CREATE TABLE `sync_operations` (
	`user_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `operation_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`registered_at` integer NOT NULL,
	`device_ids` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
