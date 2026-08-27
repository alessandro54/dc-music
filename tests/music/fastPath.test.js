// The fast path: a cold play tries cookie-free through the proxy first and
// falls back to the cookie-authenticated path when no audio arrives. Both env
// vars are read at module load, so this file sets them before importing —
// which is also why it lives apart from streamDuration.test.js, where the
// module must load unproxied.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("YTDLP_PROXY", "socks5://warp:1080");
Deno.env.set("YOUTUBE_COOKIES", "# Netscape HTTP Cookie File\n");

const { createStream, _resetShutdownForTests } = await import("@/discord/services/streamService.js");

const URL_A = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SIDECAR = `/tmp/yt-duration-dQw4w9WgXcQ.txt`;

const realCommand = Deno.Command;
let spawned = [];
// Bytes each spawn emits, consumed in order — [0, 4096] means the first
// attempt produces nothing and the retry succeeds.
let emitPlan = [];

// stderr each spawn emits, consumed in order alongside emitPlan.
let stderrPlan = [];

class FakeCommand {
    constructor(cmd, opts) {
        this.record = { cmd, args: opts.args ?? [], signals: [] };
        spawned.push(this.record);
        this.bytes = emitPlan.length ? emitPlan.shift() : 4096;
        this.stderr = stderrPlan.length ? stderrPlan.shift() : "";
    }
    spawn() {
        const record = this.record;
        const bytes = this.bytes;
        const stderrText = this.stderr;
        let settle;
        // An extraction that yields nothing exits on its own; a live one keeps
        // running until killed.
        const status = bytes === 0
            ? Promise.resolve({ success: false, code: 1, signal: null })
            : new Promise((r) => {
                settle = r;
            });
        return {
            stdout: new ReadableStream({
                start(c) {
                    if (bytes) c.enqueue(new Uint8Array(bytes));
                    c.close();
                },
            }),
            stdin: new WritableStream(),
            stderr: (async function* () {
                if (stderrText) yield new TextEncoder().encode(stderrText);
            })(),
            status,
            output: () =>
                status.then(() => ({ code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() })),
            kill(signal) {
                record.signals.push(signal);
                settle?.({ success: false, code: null, signal });
            },
        };
    }
}

function setup(plan = [], stderrs = []) {
    spawned = [];
    emitPlan = [...plan];
    stderrPlan = [...stderrs];
    _resetShutdownForTests();
    Deno.Command = FakeCommand;
}

function restore() {
    Deno.Command = realCommand;
    try {
        Deno.removeSync(SIDECAR);
    } catch { /* nothing to clean */ }
}

const usedCookies = (args) => args.includes("--cookies");
const usedProxy = (args) => args.includes("--proxy");
// Which player_client list an attempt was pinned to — the escalation's whole
// point is that the last attempt asks YouTube as a *different* client.
const pinnedClients = (args) =>
    args.find((a) => typeof a === "string" && a.includes("player_client="))?.split("player_client=")[1] ??
        null;

Deno.test("first attempt goes through the proxy without cookies", async () => {
    setup();
    try {
        await createStream(URL_A, 0, () => {});
        assertEquals(spawned.length, 1, "should not retry when the fast path works");
        assert(usedProxy(spawned[0].args), "fast attempt must use the proxy");
        assert(!usedCookies(spawned[0].args), "cookies are the ~6s tax the fast path exists to skip");
    } finally {
        restore();
    }
});

Deno.test("no audio on the fast path retries with cookies", async () => {
    setup([0, 4096]); // first spawn silent, retry produces audio
    try {
        const resource = await createStream(URL_A, 0, () => {});
        assert(resource, "fallback should still yield a playable resource");
        assertEquals(spawned.length, 2, "expected exactly one retry");
        assert(!usedCookies(spawned[0].args), "first attempt should be cookie-free");
        assert(usedCookies(spawned[1].args), "retry must carry cookies — that is the whole fallback");
    } finally {
        restore();
    }
});

Deno.test("a silent fast attempt is reaped, not left running", async () => {
    setup([0, 4096]);
    try {
        await createStream(URL_A, 0, () => {});
        assert(spawned[0].signals.length > 0, "abandoned fast attempt was never killed");
    } finally {
        restore();
    }
});

Deno.test("every attempt silent throws instead of playing silence", async () => {
    setup([0, 0, 0]);
    try {
        let threw = null;
        await createStream(URL_A, 0, () => {}).catch((e) => {
            threw = e.message;
        });
        // Throwing lets the queue skip the track immediately; returning a dead
        // resource would leave the listener with 25s of nothing.
        assertEquals(threw, "stream produced no audio");
        assertEquals(spawned.length, 3, "cookie-free, cookied, then escalated clients");
    } finally {
        restore();
    }
});

Deno.test("a dead player_client pin escalates to the fallback clients", async () => {
    // The failure mode this exists for: YouTube stops serving the pinned client
    // and *every* play goes silent at once, as happened on 2026-08-18. The third
    // attempt is what turns that from an outage into a slow play.
    setup([0, 0, 4096]);
    try {
        const resource = await createStream(URL_A, 0, () => {});
        assert(resource, "the escalated attempt should yield a playable resource");
        assertEquals(spawned.length, 3);
        assert(usedCookies(spawned[2].args), "the escalation is an authenticated attempt");
        assert(
            pinnedClients(spawned[2].args) !== pinnedClients(spawned[1].args),
            "escalating to the same clients that just failed would be pointless",
        );
    } finally {
        restore();
    }
});

Deno.test("one fast-path miss does not disable the proxy", async () => {
    // The miss is expected — the cookie-free attempt is documented to fail on
    // ~25% of unseen videos, which is the entire reason the cookie path exists.
    // Treating a single one as a proxy fault put WARP in a 5min cooldown on
    // roughly every fourth cold play, and the cooldown disables the fast path,
    // so nothing re-tested it: the hop was off far more than it was on.
    setup([0, 4096]);
    try {
        await createStream(URL_A, 0, () => {});
        spawned = [];
        emitPlan = [4096];
        await createStream(URL_A, 0, () => {});
        assert(usedProxy(spawned[0].args), "proxy should survive a single miss");
        assert(!usedCookies(spawned[0].args), "the fast path should be intact");
    } finally {
        restore();
    }
});

Deno.test("three misses in a row do disable it", async () => {
    // A hop that has actually stopped working misses every time, so it is out
    // after three plays rather than never — the cooldown still exists, it just
    // needs evidence.
    setup([0, 4096, 0, 4096, 0, 4096]);
    try {
        for (let i = 0; i < 3; i++) await createStream(URL_A, 0, () => {});
        spawned = [];
        emitPlan = [4096];
        await createStream(URL_A, 0, () => {});
        assertEquals(spawned.length, 1, "cooldown should mean a single direct attempt");
        assert(!usedProxy(spawned[0].args), "proxy is in cooldown");
        assert(usedCookies(spawned[0].args), "direct path is the authenticated one");
    } finally {
        restore();
    }
});

Deno.test("a hit resets the strikes", async () => {
    // Two misses either side of a working play are not a run — without the reset
    // the counter would eventually trip on nothing but ordinary 25% misses.
    setup([0, 4096, 4096, 0, 4096]);
    try {
        await createStream(URL_A, 0, () => {}); // miss, then cookies
        await createStream(URL_A, 0, () => {}); // fast hit — resets
        await createStream(URL_A, 0, () => {}); // miss
        spawned = [];
        emitPlan = [4096];
        await createStream(URL_A, 0, () => {});
        assert(usedProxy(spawned[0].args), "two non-consecutive misses are not a run");
    } finally {
        restore();
    }
});

const LOGIN_GATE =
    "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies for the authentication.";

Deno.test("a login gate does not put the proxy in cooldown", async () => {
    // Observed on prod: one gated video disabled WARP for 5min while WARP was
    // healthy, so every play in that window paid the slow authenticated path —
    // and the cookies it forced were the thing being gated.
    setup([0, 0], [LOGIN_GATE, LOGIN_GATE]);
    try {
        await createStream(URL_A, 0, () => {}).catch(() => {});
        // Let the stderr watcher drain before checking what it concluded.
        await new Promise((r) => setTimeout(r, 10));
        spawned = [];
        emitPlan = [4096];
        stderrPlan = [];
        await createStream(URL_A, 0, () => {});
        assert(usedProxy(spawned[0].args), "proxy should still be in use after a login gate");
        assert(!usedCookies(spawned[0].args), "the fast path should be intact");
    } finally {
        restore();
    }
});
