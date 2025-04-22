CREATE TABLE `sync_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`resource_id` text NOT NULL
);
