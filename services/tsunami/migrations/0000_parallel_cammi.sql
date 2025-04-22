CREATE TABLE `sync_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`user_ids` text NOT NULL,
	`provider` text NOT NULL,
	`resource_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_plan_resource_id_unique` ON `sync_plan` (`resource_id`);