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
}

export function getDb() {
    return db ?? null;
}
