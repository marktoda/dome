CREATE TABLE `contents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contents_r2_key_unique` ON `contents` (`r2_key`);