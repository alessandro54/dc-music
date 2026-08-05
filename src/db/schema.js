import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const songHistory = sqliteTable("song_history", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    userId: text("user_id"),
    userTag: text("user_tag"),
    title: text("title"),
    url: text("url"),
    duration: text("duration"),
    playedAt: text("played_at").default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
    index("idx_guild").on(t.guildId),
    index("idx_user").on(t.userId),
    // getSongMeta and the save dedup both look a url up by newest play — without
    // this they scan the whole log, and on Turso that scan is a network round-trip
    // sitting in front of every /play.
    index("idx_url_played").on(t.url, t.playedAt),
]);
