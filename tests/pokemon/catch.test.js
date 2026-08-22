// The catch rules are three races: only one trainer may win a spawn, a pokéball
// must not be spendable twice, and a species must not be ownable twice. All three
// are decided by SQL WHERE clauses, so these run against a real sqlite file —
// a stub would test the assertions rather than the statements.
import { assert, assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";

const dbFile = await Deno.makeTempFile({ suffix: ".db" });
Deno.env.set("DB_URL", `sqlite:${dbFile}`);
Deno.env.delete("TURSO_DATABASE_URL");

const { getDb, initDb } = await import("@/db/client.js");
await initDb();
const {
    ballsFor,
    claimSpawn,
    collectionCount,
    getCollection,
    nextRefillAt,
    ownsSpecies,
    recordSpawn,
    refundBall,
    spendBall,
} = await import("@/discord/services/pokemonService.js");
const { LIMITS } = await import("@/lib/constants.js");

const G = "g1";
const spawn = (slug, dexId = 1) => recordSpawn({ guildId: G, channelId: "c", slug, dexId });
const claim = (id, userId, slug) =>
    claimSpawn({ spawnId: id, guildId: G, userId, userTag: `${userId}#1`, slug });

// Rewinding the accrual clock is how the refill is tested without waiting 30
// real minutes.
async function rewindRefill(userId, minutes) {
    await getDb().run(sql`
        update pokemon_trainers set refilled_at = datetime('now', ${`-${minutes} minutes`})
        where user_id = ${userId}
    `);
}

Deno.test("a new trainer starts with a full pouch", async () => {
    assertEquals(await ballsFor(G, "fresh"), LIMITS.POKEBALLS_MAX);
    assertEquals(await nextRefillAt(G, "fresh"), null, "a full pouch has no pending refill");
});

Deno.test("the first presser wins the spawn, everyone else is refused", async () => {
    const id = await spawn("garchomp", 445);
    const results = await Promise.all(
        ["a", "b", "c", "d"].map((u) => claim(id, u, "garchomp")),
    );
    assertEquals(results.filter((r) => r.ok).length, 1, "exactly one winner");
    assertEquals(await collectionCount(G, "a") + await collectionCount(G, "b"), 1);
});

Deno.test("a species already owned cannot be caught again", async () => {
    const first = await spawn("pikachu", 25);
    assertEquals((await claim(first, "owner", "pikachu")).ok, true);
    assert(await ownsSpecies(G, "owner", "pikachu"));

    const second = await spawn("pikachu", 25);
    const res = await claim(second, "owner", "pikachu");
    assertEquals(res.ok, false, "the second pikachu must be refused");
    assertEquals(await collectionCount(G, "owner"), 1);

    // Still available to somebody else.
    assertEquals((await claim(second, "other", "pikachu")).ok, true);
});

Deno.test("two spawns of one species pressed at once yield one catch", async () => {
    const [x, y] = [await spawn("eevee", 133), await spawn("eevee", 133)];
    const results = await Promise.all([claim(x, "dup", "eevee"), claim(y, "dup", "eevee")]);
    assertEquals(results.filter((r) => r.ok).length, 1, "the NOT EXISTS has to hold under a race");
    assertEquals(await collectionCount(G, "dup"), 1);
});

Deno.test("spending draws a ball down and refills one interval at a time", async () => {
    for (let i = 0; i < LIMITS.POKEBALLS_MAX; i++) {
        assertEquals((await spendBall(G, "spender", "spender#1")).ok, true, `throw ${i + 1}`);
    }
    assertEquals(await ballsFor(G, "spender"), 0);

    const empty = await spendBall(G, "spender", "spender#1");
    assertEquals(empty.ok, false);
    assertEquals(empty.reason, "empty");
    assert(empty.nextRefillAt instanceof Date, "an empty pouch must say when the next ball lands");

    // One interval later: exactly one ball, not a full pouch.
    await rewindRefill("spender", LIMITS.POKEBALL_REFILL_MIN);
    assertEquals(await ballsFor(G, "spender"), 1);

    // Accrual is derived from (now - refilled_at) on every read, not banked into
    // the stored balance — only a spend writes it down. So rewinding to two and a
    // half intervals reads as 2 from a stored zero, and the trailing half interval
    // is still on the clock rather than lost.
    await rewindRefill("spender", LIMITS.POKEBALL_REFILL_MIN * 2.5);
    assertEquals(await ballsFor(G, "spender"), 2);

    // Spending now writes the derived total down, minus the one thrown.
    assertEquals((await spendBall(G, "spender", "spender#1")).ok, true);
    assertEquals(await ballsFor(G, "spender"), 1);
    const pending = await nextRefillAt(G, "spender");
    const minutes = (pending.getTime() - Date.now()) / 60_000;
    assert(
        minutes > 0 && minutes <= LIMITS.POKEBALL_REFILL_MIN / 2 + 1,
        `the half interval should survive the spend, got ${minutes.toFixed(1)}m`,
    );
});

Deno.test("accrual never exceeds the cap, and a full pouch doesn't bank time", async () => {
    await spendBall(G, "capped", "capped#1");
    await rewindRefill("capped", LIMITS.POKEBALL_REFILL_MIN * 50);
    assertEquals(await ballsFor(G, "capped"), LIMITS.POKEBALLS_MAX, "capped, not 50");

    // Spending from a capped-by-accrual pouch must restart the clock rather than
    // leaving 50 intervals of credit banked behind it.
    assertEquals((await spendBall(G, "capped", "capped#1")).ok, true);
    assertEquals(await ballsFor(G, "capped"), LIMITS.POKEBALLS_MAX - 1, "not instantly refilled");
});

Deno.test("concurrent throws cannot overdraw the pouch", async () => {
    for (let i = 0; i < LIMITS.POKEBALLS_MAX - 1; i++) await spendBall(G, "race", "race#1");
    assertEquals(await ballsFor(G, "race"), 1);

    const results = await Promise.all(
        Array.from({ length: 5 }, () => spendBall(G, "race", "race#1")),
    );
    assertEquals(results.filter((r) => r.ok).length, 1, "one ball, one winner");
    assertEquals(await ballsFor(G, "race"), 0, "never negative");
});

Deno.test("a refund returns the ball without regenerating the clock", async () => {
    await spendBall(G, "refund", "refund#1");
    const before = await ballsFor(G, "refund");
    await refundBall(G, "refund");
    assertEquals(await ballsFor(G, "refund"), before + 1);

    // A refund on a full pouch must not push it over the cap.
    await refundBall(G, "refund");
    assertEquals(await ballsFor(G, "refund"), LIMITS.POKEBALLS_MAX);
});

Deno.test("a collection lists what was won, newest first", async () => {
    const a = await spawn("snorlax", 143);
    await claim(a, "collector", "snorlax");
    const b = await spawn("mimikyu", 778);
    await claim(b, "collector", "mimikyu");

    const rows = await getCollection(G, "collector");
    assertEquals(rows.map((r) => r.slug), ["mimikyu", "snorlax"]);
    assertEquals(await collectionCount(G, "collector"), 2);
});

globalThis.addEventListener("unload", () => {
    try {
        Deno.removeSync(dbFile);
    } catch { /* temp file */ }
});
