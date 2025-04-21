CREATE TABLE `content_blobs` (
	`sha` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`r2Key` text NOT NULL,
	`mimeType` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_blobs_r2Key_unique` ON `content_blobs` (`r2Key`);--> statement-breakpoint
CREATE TABLE `provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`provider` text NOT NULL,
	`installationId` text,
	`accessToken` text,
	`refreshToken` text,
	`tokenExpiry` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`provider` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`lastSyncedAt` integer,
	`lastCommitSha` text,
	`etag` text,
	`rateLimitReset` integer,
	`retryCount` integer DEFAULT 0,
	`nextRetryAt` integer,
	`isPrivate` integer DEFAULT false NOT NULL,
	`includePatterns` text,
	`excludePatterns` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repository_files` (
	`id` text PRIMARY KEY NOT NULL,
	`repoId` text NOT NULL,
	`path` text NOT NULL,
	`sha` text NOT NULL,
	`size` integer NOT NULL,
	`mimeType` text NOT NULL,
	`lastModified` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
