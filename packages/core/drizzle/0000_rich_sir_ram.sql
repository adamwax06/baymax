CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_key` text NOT NULL,
	`name` text,
	`manufacturer` text,
	`model` text,
	`hardware_version` text,
	`software_version` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_device_key_unique` ON `devices` (`device_key`);--> statement-breakpoint
CREATE TABLE `samples` (
	`hk_uuid` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` real,
	`unit` text,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`source_id` integer NOT NULL,
	`device_id` integer,
	`metadata` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_samples_type_start` ON `samples` (`type`,`start_ts`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bundle_id` text NOT NULL,
	`name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_bundle_id_unique` ON `sources` (`bundle_id`);--> statement-breakpoint
CREATE TABLE `workouts` (
	`hk_uuid` text PRIMARY KEY NOT NULL,
	`activity_type_raw` integer NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`duration_s` real NOT NULL,
	`distance_m` real,
	`active_energy_kcal` real,
	`source_id` integer NOT NULL,
	`device_id` integer,
	`metadata` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workouts_start` ON `workouts` (`start_ts`);