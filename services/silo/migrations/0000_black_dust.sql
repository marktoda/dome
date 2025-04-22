CREATE TABLE `contents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1,
	`title` text,
	`summary` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contents_r2_key_unique` ON `contents` (`r2_key`);--> statement-breakpoint
CREATE TABLE `dlq_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`original_message_id` text NOT NULL,
	`queue_name` text NOT NULL,
	`error_message` text NOT NULL,
	`error_name` text NOT NULL,
	`failed_at` integer NOT NULL,
	`retry_count` integer NOT NULL,
	`reprocessed` integer DEFAULT false,
	`reprocessed_at` integer,
	`recovery_result` text,
	`original_message_type` text NOT NULL,
	`original_message_json` text NOT NULL
);
