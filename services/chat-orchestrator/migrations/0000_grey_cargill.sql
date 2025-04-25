CREATE TABLE `checkpoints` (
	`run_id` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`state_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text
);
