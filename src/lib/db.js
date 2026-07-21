import { log } from "./logger.js";

let adapter;

async function initSqlite(path) {
    const { Database } = await import("@db/sqlite");
    const db = new Database(path);
    db.exec(`CREATE TABLE IF NOT EXISTS song_history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id  TEXT NOT NULL,
        user_id   TEXT,
        user_tag  TEXT,
        title     TEXT,
        url       TEXT,
        duration  TEXT,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_guild ON song_history (guild_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user ON song_history (user_id)`);
    const insert = db.prepare(
        "INSERT INTO song_history (guild_id, user_id, user_tag, title, url, duration) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const dedup = db.prepare(
        "SELECT id FROM song_history WHERE guild_id = ? AND url = ? AND played_at > datetime('now', '-5 minutes') LIMIT 1",
    );
    const select = db.prepare(
        "SELECT title, url, user_tag, duration, played_at FROM song_history WHERE guild_id = ? ORDER BY played_at DESC LIMIT ?",
    );
    // One row per url (latest play) — autocomplete suggestions, not a play log.
    const selectDistinct = db.prepare(
        "SELECT title, url, user_tag, duration, MAX(played_at) AS played_at FROM song_history WHERE guild_id = ? GROUP BY url ORDER BY played_at DESC LIMIT ?",
    );
    log.db(`SQLite ready — ${path}`);
    return {
        saveSong: ({ guildId, userId, userTag, title, url, duration }) => {
            try {
                // @db/sqlite rejects undefined binds — coerce to null.
                const n = (v) => v ?? null;
                if (!dedup.get(n(guildId), n(url))) {
                    insert.run(n(guildId), n(userId), n(userTag), n(title), n(url), duration == null ? null : String(duration));
                }
            } catch (err) { log.error(`saveSong: ${err.message}`); }
        },
        getHistory: (guildId, limit) => select.all(guildId, limit),
        getRecentSongs: (guildId, limit) => selectDistinct.all(guildId, limit),
    };
}

async function initTurso(url, authToken) {
    // /web entry = pure-HTTP Hrana client, no native bindings (Deno/Docker safe).
    const { createClient } = await import("@libsql/client/web");
    const db = createClient({ url, authToken });
    await db.batch([
        `CREATE TABLE IF NOT EXISTS song_history (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id  TEXT NOT NULL,
            user_id   TEXT,
            user_tag  TEXT,
            title     TEXT,
            url       TEXT,
            duration  TEXT,
            played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE INDEX IF NOT EXISTS idx_guild ON song_history (guild_id)`,
        `CREATE INDEX IF NOT EXISTS idx_user ON song_history (user_id)`,
    ], "write");
    log.db(`Turso ready — ${url}`);

    const n = (v) => v ?? null;
    return {
        saveSong: async ({ guildId, userId, userTag, title, url, duration }) => {
            try {
                const dup = await db.execute({
                    sql: "SELECT id FROM song_history WHERE guild_id = ? AND url = ? AND played_at > datetime('now', '-5 minutes') LIMIT 1",
                    args: [n(guildId), n(url)],
                });
                if (!dup.rows.length) {
                    await db.execute({
                        sql: "INSERT INTO song_history (guild_id, user_id, user_tag, title, url, duration) VALUES (?, ?, ?, ?, ?, ?)",
                        args: [n(guildId), n(userId), n(userTag), n(title), n(url), duration == null ? null : String(duration)],
                    });
                }
            } catch (err) { log.error(`saveSong: ${err.message}`); }
        },
        getHistory: async (guildId, limit) => {
            const res = await db.execute({
                sql: "SELECT title, url, user_tag, duration, played_at FROM song_history WHERE guild_id = ? ORDER BY played_at DESC LIMIT ?",
                args: [guildId, limit],
            });
            return res.rows.map((r) => ({
                title: r.title, url: r.url, user_tag: r.user_tag, duration: r.duration, played_at: r.played_at,
            }));
        },
        // One row per url (latest play) — autocomplete suggestions, not a play log.
        getRecentSongs: async (guildId, limit) => {
            const res = await db.execute({
                sql: "SELECT title, url, user_tag, duration, MAX(played_at) AS played_at FROM song_history WHERE guild_id = ? GROUP BY url ORDER BY played_at DESC LIMIT ?",
                args: [guildId, limit],
            });
            return res.rows.map((r) => ({
                title: r.title, url: r.url, user_tag: r.user_tag, duration: r.duration, played_at: r.played_at,
            }));
        },
    };
}

export async function initDb() {
    const tursoUrl = Deno.env.get("TURSO_DATABASE_URL");
    const dbUrl = Deno.env.get("DB_URL") ?? "";
    if (tursoUrl || dbUrl.startsWith("libsql://")) {
        adapter = await initTurso(tursoUrl ?? dbUrl, Deno.env.get("TURSO_AUTH_TOKEN"));
    } else {
        const path = dbUrl.startsWith("sqlite:") ? dbUrl.slice(7) : "./bot.db";
        adapter = await initSqlite(path);
    }
}

export async function saveSong(data) {
    await adapter?.saveSong(data);
}

export async function getHistory(guildId, limit = 10) {
    return (await adapter?.getHistory(guildId, limit)) ?? [];
}

export async function getRecentSongs(guildId, limit = 10) {
    return (await adapter?.getRecentSongs(guildId, limit)) ?? [];
}
