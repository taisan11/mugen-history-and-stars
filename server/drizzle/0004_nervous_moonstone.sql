CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sessions_token_hash_unique` ON `admin_sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `auth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_codes_code_hash_unique` ON `auth_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`client` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`replaced_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_token_hash_unique` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_user_idx` ON `auth_tokens` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `auth_tokens_expiry_idx` ON `auth_tokens` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `display_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `password_salt` text;--> statement-breakpoint
ALTER TABLE `users` ADD `password_iterations` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_login_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);