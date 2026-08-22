CREATE TABLE `pokedex` (
	`slug` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`fetched_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `pokemon_spawns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text,
	`message_id` text,
	`slug` text NOT NULL,
	`dex_id` integer,
	`spawned_at` text DEFAULT CURRENT_TIMESTAMP,
	`caught_by` text,
	`caught_by_tag` text,
	`caught_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_spawn_owner` ON `pokemon_spawns` (`guild_id`,`caught_by`,`caught_at`);--> statement-breakpoint
CREATE TABLE `pokemon_trainers` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_tag` text,
	`balls` integer NOT NULL,
	`refilled_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_trainer` ON `pokemon_trainers` (`guild_id`,`user_id`);