// The /radio station keeps itself stocked, and the ways that can go wrong are all
// invisible from reading it: a refill fired twice queues the batch twice, a
// refill that outlives /stop resurrects a dead session, and an unbounded retry
// turns a YouTube outage into a hot loop.
import { assert, assertEquals } from "@std/assert";

import { GuildQueue } from "@/discord/guildQueue.js";
import { LIMITS } from "@/lib/constants.js";

const seed = { id: "abc", title: "Seed Song", requestedBy: "kld", requestedById: "1" };
const song = (title) => ({ title, url: `https://youtu.be/${title}` });

// _advance is what every track change funnels through, so it stands in for
// playback here. The queue is never connected: nothing under test touches voice.
function stationQueue(onRefill) {
    const queue = new GuildQueue("g", { onRefill });
    queue.startStation(seed);
    return queue;
}

Deno.test("a station refills once the wait list runs short", () => {
    let calls = 0;
    const queue = stationQueue(() => calls++);
    queue.songs = Array.from({ length: LIMITS.RADIO_LOW_WATER + 1 }, (_, i) => song(`s${i}`));

    queue._advance();
    assertEquals(calls, 0, "a full queue should not be asking for more");

    queue.songs.pop();
    queue._advance();
    assertEquals(calls, 1, "at the low-water mark it should refill");
});

Deno.test("an in-flight refill is not started again", () => {
    let calls = 0;
    const queue = stationQueue(() => calls++); // never calls refillDone: still in flight
    queue.songs = [song("only")];

    queue._advance();
    queue._advance();
    queue._advance();

    assertEquals(calls, 1, "every track change calls _advance — the flag is what stops a stampede");

    queue.refillDone();
    queue._advance();
    assertEquals(calls, 2, "once the refill lands, the next one is allowed");
});

Deno.test("an empty queue still refills rather than only winding down", () => {
    let calls = 0;
    const queue = stationQueue(() => calls++);
    queue.songs = [];

    queue._advance();

    assertEquals(calls, 1, "a drained station is exactly when it must top up");
    clearTimeout(queue._idleTimeout); // the leave countdown it armed; addMany would clear it
});

Deno.test("stopping the queue turns the station off", () => {
    const queue = stationQueue(() => {});
    assert(queue.station, "station should be armed");

    queue.stop();

    assertEquals(queue.station, null, "/stop and the stop button both land here");
});

Deno.test("a refill after teardown finds no station to fill", () => {
    let calls = 0;
    const queue = stationQueue(() => calls++);
    queue.destroy();
    queue.songs = [];

    queue._advance();

    assertEquals(calls, 0, "a destroyed queue must not keep asking YouTube for tracks");
});

Deno.test("a throwing refill clears its own in-flight flag", () => {
    let calls = 0;
    const queue = stationQueue(() => {
        calls++;
        throw new Error("innertube exploded");
    });
    queue.songs = [];

    queue._advance();
    queue._advance();

    assertEquals(calls, 2, "a synchronous failure must not wedge the station shut forever");
    clearTimeout(queue._idleTimeout);
});
