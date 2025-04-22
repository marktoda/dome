CREATE TABLE `sync_history` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_plan_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`provider` text NOT NULL,
	`user_id` text,
	`started_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	`previous_cursor` text,
	`new_cursor` text,
	`files_processed` integer DEFAULT 0 NOT NULL,
	`updated_files` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	FOREIGN KEY (`sync_plan_id`) REFERENCES `sync_plan`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`user_ids` text NOT NULL,
	`provider` text NOT NULL,
	`resource_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_plan_resource_id_unique` ON `sync_plan` (`resource_id`);