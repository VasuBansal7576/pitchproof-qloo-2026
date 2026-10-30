CREATE TABLE `command_receipts` (
	`project_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`command_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_version` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `command_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_owner_updated` ON `projects` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `provider_usage` (
	`owner_id` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `reference_candidates` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`slot` integer NOT NULL,
	`input_hash` text NOT NULL,
	`query` text NOT NULL,
	`entity_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `candidates_expiry` ON `reference_candidates` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
