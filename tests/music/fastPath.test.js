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

Deno.test("both attempts silent throws instead of playing silence", async () => {
    setup([0, 0]);
    try {
        let threw = null;
        await createStream(URL_A, 0, () => {}).catch((e) => {
            threw = e.message;
        });
        // Throwing lets the queue skip the track immediately; returning a dead
        // resource would leave the listener with 25s of nothing.
        assertEquals(threw, "stream produced no audio");
        assertEquals(spawned.length, 2);
    } finally {
        restore();
    }
});

Deno.test("after a proxy failure the next play skips the fast path", async () => {
    setup([0, 4096]);
    try {
        await createStream(URL_A, 0, () => {}); // trips the cooldown
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
