import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    // True when the track arrived as part of a playlist/album/set rather than
    // being asked for by name. Those plays still count towards /leaderboard —
    // they were played — but they're filler in the "recently played" lists, where
    // one 100-track playlist would bury every deliberate pick.
    viaPlaylist: integer("via_playlist", { mode: "boolean" }),
    // Which resolver the request came from: "youtube" | "spotify" | "soundcloud".
    // Provenance, not where the audio came from — a Spotify request is resolved to
    // a YouTube video at play time, so it lands here as "spotify" while `url` is a
    // youtube.com link. That's exactly why this can't be derived from the url.
    source: text("source"),
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

// PokéAPI responses, kept because a pokédex entry never changes — the one kind of
// data where a cache with no expiry is correct rather than lazy. The in-memory
// map in pokemonService is still the first hop; this is what makes the second
// lookup after a deploy free instead of a round-trip to a free public API.
// Stored as the already-narrowed shape the card renders, not the raw response:
// re-deriving it on read would put the parsing rules in two places.
export const pokedex = sqliteTable("pokedex", {
    // The colorscripts name, which is what we look entries up by. Not the
    // national dex number: the 31 form-less species (deoxys, giratina) resolve
    // through here by slug before an id is known.
    slug: text("slug").primaryKey(),
    data: text("data").notNull(), // JSON — the dex entry shape from pokemonService
    fetchedAt: text("fetched_at").default(sql`CURRENT_TIMESTAMP`),
});

// Every pokémon that has appeared, and who got it. This table *is* the game
// ledger: "first to catch keeps it" is one UPDATE with `caught_by is null` in the
// WHERE, so the database picks the winner and rowsAffected reports it. A separate
// collection table would need that same race decided somewhere else first.
//
// A collection is therefore a query, not a table. Owning a species twice is
// forbidden, but that rule can't be a unique index here: these rows exist before
// anyone claims them, and every unclaimed spawn has caught_by null, so an index on
// (guild, caught_by, slug) would let only one *uncaught* spawn of a species exist
// at a time. It is enforced in the claim statement instead — see claimSpawn.
export const pokemonSpawns = sqliteTable("pokemon_spawns", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id"),
    messageId: text("message_id"),
    slug: text("slug").notNull(),
    dexId: integer("dex_id"),
    spawnedAt: text("spawned_at").default(sql`CURRENT_TIMESTAMP`),
    // Null until someone claims it. The claim is the win.
    caughtBy: text("caught_by"),
    caughtByTag: text("caught_by_tag"),
    caughtAt: text("caught_at"),
}, (t) => [
    // The catch path looks a spawn up by id; /collection reads one user's wins
    // newest-first, and the leaderboard counts them.
    index("idx_spawn_owner").on(t.guildId, t.caughtBy, t.caughtAt),
]);

// Pokéball charges. Deliberately not a countdown in memory: charges accrue with
// wall-clock time, so the row stores the balance and the instant it was last
// accrued, and every read derives the current total from that. A timer would
// forget everything on deploy and hand everyone a full pouch.
export const pokemonTrainers = sqliteTable("pokemon_trainers", {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    userTag: text("user_tag"),
    balls: integer("balls").notNull(),
    // The instant `balls` was last correct. Advanced by whole refill intervals
    // when charges are granted, so a partially elapsed interval is never lost —
    // and pinned to now once the pouch is full, or time would bank indefinitely
    // and a full pouch would refill instantly after spending.
    refilledAt: text("refilled_at").default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
    uniqueIndex("idx_trainer").on(t.guildId, t.userId),
]);
