CREATE TABLE IF NOT EXISTS `song_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text,
	`user_tag` text,
	`title` text,
	`url` text,
	`duration` text,
	`played_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_guild` ON `song_history` (`guild_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user` ON `song_history` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_url_played` ON `song_history` (`url`,`played_at`);