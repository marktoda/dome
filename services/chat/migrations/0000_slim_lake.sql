CREATE TABLE `checkpoints` (
	`run_id` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`state_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text
);
--> statement-breakpoint
CREATE TABLE `data_retention_consents` (
	`user_id` text NOT NULL,
	`data_category` text NOT NULL,
	`consented_at` integer NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`user_id`, `data_category`)
);
--> statement-breakpoint
CREATE TABLE `data_retention_records` (
	`record_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`data_category` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`anonymized` integer DEFAULT false
);
