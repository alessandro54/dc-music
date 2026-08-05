DROP INDEX IF EXISTS `idx_url_played`;--> statement-breakpoint
ALTER TABLE `song_history` ADD `fingerprint` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_fingerprint_played` ON `song_history` (`fingerprint`,`played_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_guild_fingerprint` ON `song_history` (`guild_id`,`fingerprint`);