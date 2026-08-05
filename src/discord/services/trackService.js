import { and, desc, eq, gt, isNotNull, max, sql } from "drizzle-orm";
import { dbKind, getDb } from "@/db/client.js";
import { songHistory } from "@/db/schema.js";
import { log } from "@/lib/logger.js";
import { captureError } from "@/lib/sentry.js";

export async function saveSong({ guildId, userId, userTag, title, url, duration }) {
    const db = getDb();
    if (!db) return;
    try {
        const dup = await db
            .select({ id: songHistory.id })
            .from(songHistory)
            .where(and(
                eq(songHistory.guildId, guildId ?? null),
                eq(songHistory.url, url ?? null),
                gt(songHistory.playedAt, sql`datetime('now', '-5 minutes')`),
            ))
            .limit(1);
        if (!dup.length) {
            await db.insert(songHistory).values({
                guildId,
                userId: userId ?? null,
                userTag: userTag ?? null,
                title: title ?? null,
                url: url ?? null,
                duration: duration == null ? null : String(duration),
            });
        }
    } catch (err) {
        log.error(`saveSong: ${err.message}`);
        captureError(err, { tags: { stage: "db", adapter: dbKind }, extra: { guildId, url } });
    }
}

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
        .where(eq(songHistory.guildId, guildId))
        .orderBy(desc(songHistory.playedAt))
        .limit(limit);
}

// One row per url (latest play) — autocomplete suggestions, not a play log.
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
        .where(eq(songHistory.guildId, guildId))
        .groupBy(songHistory.url)
        .orderBy(desc(max(songHistory.playedAt)))
        .limit(limit);
}

// Metadata of an already-played track — beats re-asking yt-dlp (seconds).
export async function getSongMeta(url) {
    const db = getDb();
    if (!db) return null;
    try {
        const rows = await db
            .select({ title: songHistory.title, duration: songHistory.duration })
            .from(songHistory)
            .where(and(eq(songHistory.url, url), isNotNull(songHistory.title)))
            .orderBy(desc(songHistory.playedAt))
            .limit(1);
        return rows[0] ?? null;
    } catch {
        return null; // metadata lookup is an optimisation — never fail a /play over it
    }
}
