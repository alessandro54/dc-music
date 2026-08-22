import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { getDb } from "@/db/client.js";
import { pokedex, pokemonSpawns, pokemonTrainers } from "@/db/schema.js";
import { renderSpritePng } from "@/discord/services/spriteImageService.js";
import { LIMITS, TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";

const POKEMON_COLORSCRIPTS = Deno.env.get("POKEMON_COLORSCRIPTS_PATH") || "pokemon-colorscripts";
const POKEAPI = "https://pokeapi.co/api/v2";

const dec = new TextDecoder();

// Pokédex entries never change, so this cache has no expiry — the one case where
// that is correct rather than lazy. 905 possible entries of small JSON, and it
// spares PokéAPI the repeat traffic its docs ask callers to avoid (there is no
// key and no hard rate limit any more, just fair use).
const dexCache = new Map();

// Returns { name, png } — png is a true-color raster of the sprite (Buffer).
// `name` selects a specific pokémon; omitted means random.
export async function getRandomPokemon(name = null) {
    const args = name ? ["--name", name] : ["--random"];
    const { code, stdout, stderr } = await new Deno.Command(POKEMON_COLORSCRIPTS, {
        args,
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (code !== 0) {
        throw new Error(`pokemon-colorscripts failed: ${dec.decode(stderr).trim() || "unknown error"}`);
    }
    // Output is "<name>\n<art>" — name line, then the sprite.
    const [rawName, ...artLines] = dec.decode(stdout).replace(/\n+$/, "").split("\n");
    const slug = rawName.trim();
    const png = await renderSpritePng(artLines.join("\n"));
    return { name: prettyName(slug), slug, png };
}

export function prettyName(slug) {
    return slug.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join("-");
}

// PokéAPI has no timeout of its own and `fetch` has no default one, so an
// unresponsive host would otherwise hold the interaction open until Discord
// expires the token — the same reason every yt-dlp call here carries a deadline.
async function getJson(path) {
    const res = await fetch(`${POKEAPI}${path}`, {
        signal: AbortSignal.timeout(TIMEOUTS.POKEAPI_MS),
        headers: { accept: "application/json" },
    });
    if (!res.ok) {
        // Read the body out even on failure: an unconsumed response body keeps
        // the connection out of the pool.
        await res.body?.cancel();
        const err = new Error(`PokéAPI ${res.status} for ${path}`);
        err.status = res.status;
        throw err;
    }
    return await res.json();
}

// Everything the card shows, or null if PokéAPI can't answer. Null is a first
// class outcome: /pokemon existed before this data did, so a third-party outage
// must degrade to the plain sprite rather than break the command.
export async function fetchDexEntry(slug) {
    if (dexCache.has(slug)) return dexCache.get(slug);

    // Then the database, which is what makes the first lookup after a deploy free
    // rather than a round-trip to a free public API. Entries are immutable, so a
    // hit here is never stale.
    const stored = await readDexCache(slug);
    if (stored) {
        dexCache.set(slug, stored);
        return stored;
    }

    try {
        const entry = await loadDexEntry(slug);
        dexCache.set(slug, entry);
        // Not awaited: the card is already renderable, and a slow write must not
        // sit in front of the reply.
        void writeDexCache(slug, entry);
        return entry;
    } catch (err) {
        // Not captured to Sentry: a fun command degrading because a free public
        // API had a bad minute is not a bug worth an issue.
        log.warn(`[pokemon] no dex data for ${slug}: ${err.message}`);
        return null;
    }
}

async function readDexCache(slug) {
    const db = getDb();
    if (!db) return null;
    try {
        const rows = await db.select({ data: pokedex.data }).from(pokedex).where(eq(pokedex.slug, slug))
            .limit(1);
        return rows[0] ? JSON.parse(rows[0].data) : null;
    } catch (err) {
        // A broken cache must never break the lookup behind it.
        log.warn(`[pokemon] dex cache read ${slug}: ${err.message}`);
        return null;
    }
}

async function writeDexCache(slug, entry) {
    const db = getDb();
    if (!db) return;
    try {
        await db.insert(pokedex).values({ slug, data: JSON.stringify(entry) }).onConflictDoNothing();
    } catch (err) {
        log.warn(`[pokemon] dex cache write ${slug}: ${err.message}`);
    }
}

async function loadDexEntry(slug) {
    // Both at once, because the species call is needed regardless (flavour text,
    // genus, generation) and the pokémon call succeeds for 874 of the 905 names
    // colorscripts knows. Sequential would pay for that on every lookup.
    const [speciesResult, pokemonResult] = await Promise.allSettled([
        getJson(`/pokemon-species/${slug}`),
        getJson(`/pokemon/${slug}`),
    ]);
    if (speciesResult.status === "rejected") throw speciesResult.reason;
    const species = speciesResult.value;

    let pokemon;
    if (pokemonResult.status === "fulfilled") {
        pokemon = pokemonResult.value;
    } else {
        // The other 31: pokémon with no default form under their bare name
        // (deoxys → deoxys-normal, giratina → giratina-altered). The species names
        // its own default variety, which beats a hardcoded table of exceptions
        // that would rot as new forms ship.
        const variety = species.varieties?.find((v) => v.is_default)?.pokemon?.name;
        if (!variety) throw pokemonResult.reason;
        pokemon = await getJson(`/pokemon/${variety}`);
    }

    return {
        id: pokemon.id,
        types: pokemon.types.map((t) => t.type.name),
        stats: pokemon.stats.map((st) => ({ name: st.stat.name, value: st.base_stat })),
        abilities: pokemon.abilities.map((a) => ({ name: a.ability.name, hidden: a.is_hidden })),
        // Decimetres and hectograms in the API.
        heightM: pokemon.height / 10,
        weightKg: pokemon.weight / 10,
        genus: english(species.genera, "genus"),
        // Flavour text is laid out for the games' text boxes: hard wraps, form
        // feeds where a page broke, and soft hyphens (U+00AD) at the break points.
        // The soft hyphen is the subtle one — it has to take the line break after
        // it with it, or removing one just leaves the other behind and "becomes"
        // renders as "be comes".
        flavor: english(species.flavor_text_entries, "flavor_text")
            ?.replace(/\u00ad\s*/g, "")
            .replace(/\s+/g, " ")
            .trim(),
        generation: species.generation?.name ?? null,
        legendary: species.is_legendary,
        mythical: species.is_mythical,
    };
}

function english(entries, field) {
    return entries?.find((e) => e.language?.name === "en")?.[field] ?? null;
}

// ---------------------------------------------------------------------------
// The game: spawns, pokéballs, collections.
// ---------------------------------------------------------------------------

// Charges accrue with wall-clock time rather than ticking down in memory, so a
// deploy can't hand everyone a full pouch. Both expressions below are derived
// from (now - refilled_at) on every read, which is why nothing needs a timer.
//
// SQLite integer division truncates, which is what we want: two and a half
// intervals grant two charges and the half-interval stays on the clock.
const REFILL_SECONDS = LIMITS.POKEBALL_REFILL_MIN * 60;
const GAINED = sql`
    cast((strftime('%s', 'now') - strftime('%s', ${pokemonTrainers.refilledAt})) / ${REFILL_SECONDS} as integer)
`;
const TOTAL = sql`min(${LIMITS.POKEBALLS_MAX}, ${pokemonTrainers.balls} + ${GAINED})`;

async function ensureTrainer(db, guildId, userId, userTag) {
    // A new trainer starts with a full pouch. onConflictDoNothing rather than a
    // read-then-insert: two buttons pressed at once would otherwise both insert.
    await db.insert(pokemonTrainers).values({
        guildId,
        userId,
        userTag: userTag ?? null,
        balls: LIMITS.POKEBALLS_MAX,
    }).onConflictDoNothing();
}

// Spend one charge. Returns { ok } or { ok: false, nextRefillAt }. One statement,
// because accrue-then-check-then-write is a race: two presses milliseconds apart
// would both read the same balance and both spend it.
export async function spendBall(guildId, userId, userTag) {
    const db = getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    await ensureTrainer(db, guildId, userId, userTag);

    const res = await db.run(sql`
        update ${pokemonTrainers}
        set ${sql.identifier(pokemonTrainers.balls.name)} = ${TOTAL} - 1,
            ${sql.identifier(pokemonTrainers.refilledAt.name)} = case
                -- A full pouch's clock starts when it stops being full, or time
                -- would bank while capped and the next spend would refill instantly.
                when ${TOTAL} >= ${LIMITS.POKEBALLS_MAX} then datetime('now')
                else datetime(${pokemonTrainers.refilledAt}, '+' || (${GAINED} * ${LIMITS.POKEBALL_REFILL_MIN}) || ' minutes')
            end
        where ${pokemonTrainers.guildId} is ${guildId}
          and ${pokemonTrainers.userId} is ${userId}
          and ${TOTAL} > 0
    `);
    if (res.rowsAffected > 0) return { ok: true };
    return { ok: false, reason: "empty", nextRefillAt: await nextRefillAt(guildId, userId) };
}

// Losing the race must not cost a charge — the spend happens before the claim
// because a charge is cheap to give back and a claim is not.
export async function refundBall(guildId, userId) {
    const db = getDb();
    if (!db) return;
    // refilled_at is deliberately untouched: the charge is being returned, not
    // regenerated, so the accrual clock should carry on as it was.
    await db.run(sql`
        update ${pokemonTrainers}
        set ${sql.identifier(pokemonTrainers.balls.name)} =
            min(${LIMITS.POKEBALLS_MAX}, ${pokemonTrainers.balls} + 1)
        where ${pokemonTrainers.guildId} is ${guildId} and ${pokemonTrainers.userId} is ${userId}
    `);
}

export async function ballsFor(guildId, userId) {
    const db = getDb();
    if (!db) return LIMITS.POKEBALLS_MAX;
    const rows = await db
        .select({ balls: sql`${TOTAL}`.mapWith(Number) })
        .from(pokemonTrainers)
        .where(and(eq(pokemonTrainers.guildId, guildId), eq(pokemonTrainers.userId, userId)));
    // Nobody has a row until their first catch, and a new trainer starts full.
    return rows[0]?.balls ?? LIMITS.POKEBALLS_MAX;
}

// When the next charge lands — null when the pouch is already full.
export async function nextRefillAt(guildId, userId) {
    const db = getDb();
    if (!db) return null;
    const rows = await db
        .select({
            balls: sql`${TOTAL}`.mapWith(Number),
            // Seconds until the in-progress interval completes.
            wait: sql`
                ${REFILL_SECONDS} -
                ((strftime('%s', 'now') - strftime('%s', ${pokemonTrainers.refilledAt})) % ${REFILL_SECONDS})
            `.mapWith(Number),
        })
        .from(pokemonTrainers)
        .where(and(eq(pokemonTrainers.guildId, guildId), eq(pokemonTrainers.userId, userId)));
    const row = rows[0];
    if (!row || row.balls >= LIMITS.POKEBALLS_MAX) return null;
    return new Date(Date.now() + row.wait * 1000);
}

// Already in this trainer's collection? Checked before a ball is spent, so a
// duplicate costs nothing — the claim re-checks it atomically for the race.
export async function ownsSpecies(guildId, userId, slug) {
    const db = getDb();
    if (!db) return false;
    const rows = await db
        .select({ n: sql`count(*)`.mapWith(Number) })
        .from(pokemonSpawns)
        .where(and(
            eq(pokemonSpawns.guildId, guildId),
            eq(pokemonSpawns.caughtBy, userId),
            eq(pokemonSpawns.slug, slug),
        ));
    return (rows[0]?.n ?? 0) > 0;
}

// Record a wild pokémon. The row is created before the message is posted so the
// button can carry its id; `messageId` is filled in afterwards.
export async function recordSpawn({ guildId, channelId, slug, dexId }) {
    const db = getDb();
    if (!db) return null;
    const rows = await db.insert(pokemonSpawns)
        .values({ guildId, channelId, slug, dexId: dexId ?? null })
        .returning({ id: pokemonSpawns.id });
    return rows[0]?.id ?? null;
}

export async function attachSpawnMessage(spawnId, messageId) {
    const db = getDb();
    if (!db) return;
    await db.update(pokemonSpawns).set({ messageId }).where(eq(pokemonSpawns.id, spawnId));
}

// Claim a spawn. Two rules, both in the WHERE so the database decides both:
// `caught_by is null` makes the first presser the winner — SQLite serialises the
// update, so exactly one of any number of simultaneous presses affects a row and
// rowsAffected names it — and the NOT EXISTS blocks a species this trainer already
// owns. The second rule can't live in a pre-check alone: two spawns of the same
// species pressed at the same moment would each see an empty collection.
export async function claimSpawn({ spawnId, guildId, userId, userTag, slug }) {
    const db = getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    const res = await db.run(sql`
        update ${pokemonSpawns}
        set ${sql.identifier(pokemonSpawns.caughtBy.name)} = ${userId},
            ${sql.identifier(pokemonSpawns.caughtByTag.name)} = ${userTag ?? null},
            ${sql.identifier(pokemonSpawns.caughtAt.name)} = datetime('now')
        where ${pokemonSpawns.id} = ${spawnId}
          and ${pokemonSpawns.caughtBy} is null
          and not exists (
              select 1 from ${pokemonSpawns}
              where ${pokemonSpawns.guildId} is ${guildId}
                and ${pokemonSpawns.caughtBy} is ${userId}
                and ${pokemonSpawns.slug} is ${slug}
          )
    `);
    if (res.rowsAffected > 0) return { ok: true };
    // Nothing updated: either someone was faster, or the species is already owned.
    return { ok: false, reason: "refused" };
}

export async function getSpawn(spawnId) {
    const db = getDb();
    if (!db) return null;
    const rows = await db.select().from(pokemonSpawns).where(eq(pokemonSpawns.id, spawnId)).limit(1);
    return rows[0] ?? null;
}

// A collection is a query over won spawns rather than a table of its own.
export async function getCollection(guildId, userId, limit = LIMITS.COLLECTION_PAGE) {
    const db = getDb();
    if (!db) return [];
    return await db
        .select({
            slug: pokemonSpawns.slug,
            dexId: pokemonSpawns.dexId,
            caughtAt: pokemonSpawns.caughtAt,
        })
        .from(pokemonSpawns)
        .where(and(eq(pokemonSpawns.guildId, guildId), eq(pokemonSpawns.caughtBy, userId)))
        // No grouping: a species can only be owned once, so these rows are already
        // distinct by slug.
        .orderBy(desc(pokemonSpawns.caughtAt))
        .limit(limit);
}

export async function collectionCount(guildId, userId) {
    const db = getDb();
    if (!db) return 0;
    const rows = await db
        .select({ total: sql`count(*)`.mapWith(Number) })
        .from(pokemonSpawns)
        .where(and(eq(pokemonSpawns.guildId, guildId), eq(pokemonSpawns.caughtBy, userId)));
    return rows[0]?.total ?? 0;
}

// Who has caught the most — the reason a spawn is worth racing for.
export async function catchLeaderboard(guildId, limit = 5) {
    const db = getDb();
    if (!db) return [];
    return await db
        .select({
            userId: pokemonSpawns.caughtBy,
            userTag: pokemonSpawns.caughtByTag,
            total: sql`count(*)`.mapWith(Number),
        })
        .from(pokemonSpawns)
        .where(and(eq(pokemonSpawns.guildId, guildId), isNotNull(pokemonSpawns.caughtBy)))
        .groupBy(pokemonSpawns.caughtBy)
        .orderBy(desc(sql`count(*)`))
        .limit(limit);
}
