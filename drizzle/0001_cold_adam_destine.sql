CREATE TABLE `provider_reservations` (
	`owner_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`day` text NOT NULL,
	`units` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `reservation_id`)
);
--> statement-breakpoint
CREATE TABLE `synthesis_drafts` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`context_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`, `operation_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `synthesis_drafts_expiry` ON `synthesis_drafts` (`expires_at`);