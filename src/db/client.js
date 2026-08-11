import { log } from "@/lib/logger.js";

let db;
export let dbKind = "none";

const MIGRATIONS_FOLDER = new URL("./migrations", import.meta.url).pathname;

export async function initDb() {
    const tursoUrl = Deno.env.get("TURSO_DATABASE_URL");
    const dbUrl = Deno.env.get("DB_URL") ?? "";

    let client;
    if (tursoUrl || dbUrl.startsWith("libsql://")) {
        // /web entry = pure-HTTP Hrana client, no native bindings (Deno/Docker safe).
        const { createClient } = await import("@libsql/client/web");
        client = createClient({
            url: tursoUrl ?? dbUrl,
            authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
        });
        dbKind = "turso";
    } else {
        // Local dev fallback — default entry handles file: URLs.
        const { createClient } = await import("@libsql/client");
        const path = dbUrl.startsWith("sqlite:") ? dbUrl.slice(7) : "./bot.db";
        client = createClient({ url: `file:${path}` });
        dbKind = "sqlite";
    }

    const { drizzle } = await import("drizzle-orm/libsql");
    db = drizzle({ client });

    const { migrate } = await import("drizzle-orm/libsql/migrator");
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    log.db(`DB ready (${dbKind}) — ${tursoUrl ?? (dbUrl || "./bot.db")}`);

    // Deliberately not awaited. Queries group by coalesce(fingerprint, url), so
    // they are correct while this is still running, and blocking on it would put
    // a pile of Turso round-trips in front of the bot logging in. Failure is
    // survivable for the same reason — log it and move on.
    backfillFingerprints(client).catch((err) => {
        log.error(`fingerprint backfill: ${err.message}`);
    });
}

// Rows written before the fingerprint/source columns existed have NULL, which
// would put every legacy play in one group. Derived with the same function the
// writes use, so backfilled and new rows agree; a no-op after the first boot.
//
// `source` is only a guess for legacy rows: it is read off the url, so a play that
// was *requested* from Spotify reads as "youtube", because that is the video
// _playNext resolved it to and the origin was never recorded. Unknowable now —
// only new rows carry true provenance.
const BACKFILL_CHUNK = 100;

async function backfillFingerprints(client) {
    const { rows } = await client.execute(
        `SELECT DISTINCT url FROM song_history
         WHERE url IS NOT NULL AND (fingerprint IS NULL OR source IS NULL)`,
    );
    if (!rows.length) return;

    const { trackFingerprint, isYouTubeUrl } = await import("@/lib/media.js");
    const sourceOf = (url) =>
        isYouTubeUrl(url) ? "youtube" : /soundcloud\.com|snd\.sc/i.test(url) ? "soundcloud" : null;
    const statements = rows.map((row) => {
        const url = row[0] ?? row.url;
        return {
            sql: `UPDATE song_history
                     SET fingerprint = coalesce(fingerprint, ?),
                         source      = coalesce(source, ?)
                   WHERE url = ? AND (fingerprint IS NULL OR source IS NULL)`,
            args: [trackFingerprint(url), sourceOf(url), url],
        };
    });

    // Batched because on Turso every execute() is its own HTTP round-trip —
    // one-at-a-time turns a few hundred legacy urls into a few hundred requests.
    for (let i = 0; i < statements.length; i += BACKFILL_CHUNK) {
        await client.batch(statements.slice(i, i + BACKFILL_CHUNK), "write");
    }
    log.db(`backfilled fingerprint/source for ${rows.length} distinct url(s)`);
}

export function getDb() {
    return db ?? null;
}
