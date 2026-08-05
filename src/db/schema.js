import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const songHistory = sqliteTable("song_history", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    userId: text("user_id"),
    userTag: text("user_tag"),
    title: text("title"),
    url: text("url"),
    // Stable track identity (lib/media.js trackFingerprint): `yt:<videoId>` for
    // YouTube, else the canonical url. The url column still records the exact
    // link a play used; this is what plays are counted and looked up by, so the
    // same video pasted as youtu.be/X and watch?v=X is one track.
    fingerprint: text("fingerprint"),
    duration: text("duration"),
    playedAt: text("played_at").default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
    index("idx_guild").on(t.guildId),
    index("idx_user").on(t.userId),
    // getSongMeta and the save dedup both look a track up by newest play — without
    // this they scan the whole log, and on Turso that scan is a network round-trip
    // sitting in front of every /play.
    index("idx_fingerprint_played").on(t.fingerprint, t.playedAt),
    // The leaderboard groups a guild's plays by fingerprint.
    index("idx_guild_fingerprint").on(t.guildId, t.fingerprint),
]);
