import { and, count, desc, eq, isNotNull, max, sql } from "drizzle-orm";

import { dbKind, getDb } from "@/db/client.js";
import { songHistory } from "@/db/schema.js";
import { log } from "@/lib/logger.js";
import { canonicalUrl, normalizeTitle, trackFingerprint } from "@/lib/media.js";
import { captureError } from "@/lib/sentry.js";

// Legacy rows predate the column; the boot backfill fills them, and COALESCE
// keeps grouping correct in the meantime.
const FINGERPRINT = sql`coalesce(${songHistory.fingerprint}, ${songHistory.url})`;

// "Recently played" means tracks someone chose. A playlist contributes plays but
// not picks — one 100-track album would otherwise bury every deliberate one. Rows
// written before the column exists are NULL, which `is not 1` treats as a pick.
const CHOSEN = sql`${songHistory.viaPlaylist} is not 1`;

export async function saveSong({ guildId, userId, userTag, title, url, duration, viaPlaylist, source }) {
    const db = getDb();
    if (!db) return;
    // Resolvers canonicalise too, but history is the one place where a stray URL
    // form permanently splits a song's play count.
    url = url ? canonicalUrl(url) : url;
    const fingerprint = url ? trackFingerprint(url) : null;
    // Column/table names come from the drizzle schema rather than being spelled
    // out, so a rename in schema.js propagates here instead of failing at runtime.
    // `sql.identifier` and not the column itself: interpolating the column renders
    // it table-qualified ("song_history"."guild_id"), which an INSERT column list
    // rejects.
    const fields = [
        [songHistory.guildId, guildId ?? null],
        [songHistory.userId, userId ?? null],
        [songHistory.userTag, userTag ?? null],
        [songHistory.title, title ?? null],
        [songHistory.url, url ?? null],
        [songHistory.fingerprint, fingerprint],
        [songHistory.duration, duration == null ? null : String(duration)],
        [songHistory.viaPlaylist, viaPlaylist ? 1 : 0],
        [songHistory.source, source ?? null],
    ];
    try {
        // Dedup in the database, not in two steps. A stall-retry re-enters
        // _playNext seconds later and saveSong isn't awaited, so a SELECT-then-
        // INSERT can interleave: both checks find nothing and both insert. As one
        // INSERT ... WHERE NOT EXISTS it is atomic, and it costs one round-trip
        // instead of two (on Turso, one HTTP request instead of two).
        //
        // Still a sql`` statement rather than the query builder, and it has to be:
        // `insert().select()` requires a FROM and demands every column in
        // table-definition order, so it can't express a bare-literal source row
        // that leaves `id`/`played_at` to their defaults. `onConflictDoNothing` is
        // out too — the dedup key is a 5-minute window, which no unique index
        // expresses.
        //
        // `IS` rather than `=` for the fingerprint: a NULL one (a url-less Spotify
        // placeholder) never equals itself, so `=` would dedup nothing.
        await db.run(sql`
            insert into ${songHistory} (${
            sql.join(fields.map(([column]) => sql.identifier(column.name)), sql`, `)
        })
            select ${sql.join(fields.map(([, value]) => sql`${value}`), sql`, `)}
            where not exists (
                select 1 from ${songHistory}
                where ${songHistory.guildId} is ${guildId ?? null}
                  and ${songHistory.fingerprint} is ${fingerprint}
                  and ${songHistory.playedAt} > datetime('now', '-5 minutes')
            )
        `);
    } catch (err) {
        log.error(`saveSong: ${err.message}`);
        captureError(err, { tags: { stage: "db", adapter: dbKind }, extra: { guildId, url } });
    }
}

// Excludes playlist filler — see CHOSEN.
export async function getHistory(guildId, limit = 10) {
    const db = getDb();
    if (!db) return [];
    return await db
        .select({
            title: songHistory.title,
            url: songHistory.url,
            userTag: songHistory.userTag,
            duration: songHistory.duration,
            playedAt: songHistory.playedAt,
        })
        .from(songHistory)
        .where(and(eq(songHistory.guildId, guildId), CHOSEN))
        .orderBy(desc(songHistory.playedAt))
        .limit(limit);
}

// One row per track (latest play) — autocomplete suggestions, not a play log.
// Grouped by fingerprint so the same video doesn't appear twice because it was
// once pasted as a youtu.be link. COALESCE covers rows a backfill hasn't reached.
export async function getRecentSongs(guildId, limit = 10) {
    const db = getDb();
    if (!db) return [];
    return await db
        .select({
            title: songHistory.title,
            url: songHistory.url,
            userTag: songHistory.userTag,
            duration: songHistory.duration,
            playedAt: max(songHistory.playedAt),
        })
        .from(songHistory)
        .where(and(eq(songHistory.guildId, guildId), CHOSEN))
        .groupBy(FINGERPRINT)
        .orderBy(desc(max(songHistory.playedAt)))
        .limit(limit);
}

// Most-played tracks in a guild. A "play" is a saveSong row, and saveSong drops a
// repeat of the same url within 5 minutes — so a stall-retry or a double /play
// doesn't inflate the count, but a genuine replay later does.
//
// `title` and `duration` are bare columns beside MAX(played_at): SQLite (and
// libsql) resolve those to the row holding that maximum, so the newest title for
// a url wins rather than an arbitrary one.
//
// SQL groups by fingerprint, so one video counts once however its URL was
// written. mergeVariants then folds *different uploads* of the same song, which
// only title matching can catch — that pass scans a window rather than `limit`
// rows, because two 3-play uploads only outrank a 5-play track once combined.
const MERGE_SCAN_MAX = 500;

export async function getTopSongs(guildId, limit = 5) {
    const db = getDb();
    if (!db) return [];
    const rows = await db
        .select({
            title: songHistory.title,
            url: songHistory.url,
            duration: songHistory.duration,
            plays: count(),
            lastPlayedAt: max(songHistory.playedAt),
        })
        .from(songHistory)
        .where(and(eq(songHistory.guildId, guildId), isNotNull(songHistory.title)))
        .groupBy(FINGERPRINT)
        // Ties break on recency, so the leaderboard is stable rather than
        // arbitrary when two tracks have the same play count.
        .orderBy(desc(count()), desc(max(songHistory.playedAt)))
        .limit(MERGE_SCAN_MAX);

    if (rows.length === MERGE_SCAN_MAX) {
        log.warn(`[tracks] leaderboard scanned the ${MERGE_SCAN_MAX}-row cap — counts may undercount`);
    }
    return mergeVariants(rows).slice(0, limit);
}

// Fold separate *uploads* of the same song into one entry by normalised title —
// the case a fingerprint can't catch, because they really are different videos.
// Fuzzy by nature, so the matching is deliberately narrow and stays at read time
// where the rule can improve without a migration. The surviving entry is the
// upload with the most plays (ties: most recent), so its link points at the one
// the server actually listens to.
function mergeVariants(rows) {
    const fold = (list, keyOf) => {
        const groups = new Map();
        for (const row of list) {
            const key = keyOf(row);
            const hit = groups.get(key);
            if (!hit) {
                // `_top` = plays of the single biggest variant, tracked separately
                // from the running total: comparing against the total would let
                // the first variant win every time from the third one onward.
                groups.set(key, { ...row, _top: row.plays });
                continue;
            }
            hit.plays += row.plays;
            if (row.lastPlayedAt > hit.lastPlayedAt) hit.lastPlayedAt = row.lastPlayedAt;
            if (row.plays > hit._top) {
                hit._top = row.plays;
                hit.title = row.title;
                hit.url = row.url;
            }
            hit.duration ??= row.duration;
        }
        return [...groups.values()];
    };

    return fold(rows, (r) => normalizeTitle(r.title) || canonicalUrl(r.url))
        .sort((a, b) => b.plays - a.plays || String(b.lastPlayedAt).localeCompare(String(a.lastPlayedAt)))
        // Canonicalise the link that gets rendered: a legacy row may carry a
        // `&t=30s` that would make the embed jump into the middle of the track.
        .map(({ _top, ...song }) => ({ ...song, url: canonicalUrl(song.url) }));
}

// Metadata of an already-played track — beats re-asking yt-dlp (seconds).
export async function getSongMeta(url) {
    const db = getDb();
    if (!db) return null;
    try {
        const rows = await db
            .select({ title: songHistory.title, duration: songHistory.duration })
            .from(songHistory)
            // By fingerprint, not url: a pasted youtu.be link must hit the row a
            // search-path play wrote, or the metadata race loses its cheapest source.
            .where(and(eq(songHistory.fingerprint, trackFingerprint(url)), isNotNull(songHistory.title)))
            .orderBy(desc(songHistory.playedAt))
            .limit(1);
        return rows[0] ?? null;
    } catch {
        return null; // metadata lookup is an optimisation — never fail a /play over it
    }
}
