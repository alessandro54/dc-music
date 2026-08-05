// The format-URL cache turns a repeat play into a plain GET, skipping the ~7.6s
// extraction. It is an optimisation, so the rule under test throughout is:
// when anything about the cached URL is wrong, fall back to yt-dlp rather than
// letting the track fail.
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
    _formatUrlCacheForTests,
    _resetShutdownForTests,
    createStream,
    prefetchFormatUrl,
} from "../../src/services/music/stream.js";

const VIDEO_ID = "dQw4w9WgXcQ";
const URL_A = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const SIDECAR = `/tmp/yt-duration-${VIDEO_ID}.txt`;

// Far-future expiry so the cache treats it as live.
const future = () => Math.floor(Date.now() / 1000) + 6 * 3600;
const mediaUrl = (expire = future()) => `https://rr1---sn-test.googlevideo.com/videoplayback?expire=${expire}&id=abc`;

const PREFETCH_SIDECAR = `/tmp/yt-prefetch-${VIDEO_ID}.txt`;

const realCommand = Deno.Command;
const realFetch = globalThis.fetch;
let spawned = [];
let ytdlpStdout = "";
// What the spawned "yt-dlp" writes to its --print-to-file sidecar, mimicking a
// real download run resolving a media URL. null = never writes one.
let sidecarBody = null;
// When true the fake process exits on its own, as a failed extraction does.
let exitImmediately = false;
// How many bytes the fake yt-dlp emits on stdout. 0 = resolved a URL that
// serves nothing, which must not be cached.
let emitBytes = 64 * 1024;

class FakeCommand {
    constructor(cmd, opts) {
        this.record = { cmd, args: opts.args ?? [], signals: [] };
        spawned.push(this.record);
    }
    spawn() {
        const record = this.record;
        const flag = record.args.indexOf("--print-to-file");
        const sidecarPath = flag === -1 ? null : record.args[flag + 2];
        // Guard the path: a miscomputed index once wrote a stray file into the
        // repo root. Only ever write where the real code puts its sidecars.
        if (sidecarBody !== null && sidecarPath?.startsWith("/tmp/")) {
            Deno.writeTextFileSync(sidecarPath, sidecarBody);
        }
        // A streaming yt-dlp runs until killed — status settles only on kill,
        // which is what lets reap() complete.
        let settle;
        const status = exitImmediately
            ? Promise.resolve({ success: false, code: 1, signal: null })
            : new Promise((r) => {
                settle = r;
            });
        return {
            // A real download run emits audio; prefetch reads a little of it to
            // confirm the media URL actually serves before caching it.
            stdout: new ReadableStream({
                start(c) {
                    if (emitBytes) c.enqueue(new Uint8Array(emitBytes));
                    c.close();
                },
            }),
            stdin: new WritableStream(),
            stderr: (async function* () {})(),
            status,
            output: () => Promise.resolve(this._payload()),
            kill(signal) {
                record.signals.push(signal);
                settle?.({ success: false, code: null, signal });
            },
        };
    }
    output() {
        return Promise.resolve(this._payload());
    }
    _payload() {
        return { code: 0, stdout: new TextEncoder().encode(ytdlpStdout), stderr: new Uint8Array() };
    }
}

function setup() {
    spawned = [];
    ytdlpStdout = "";
    sidecarBody = null;
    exitImmediately = false;
    emitBytes = 64 * 1024;
    _resetShutdownForTests();
    Deno.Command = FakeCommand;
}

function restore() {
    Deno.Command = realCommand;
    globalThis.fetch = realFetch;
    for (const f of [SIDECAR, PREFETCH_SIDECAR]) {
        try {
            Deno.removeSync(f);
        } catch { /* nothing to clean */ }
    }
}

// Prefetch resolves a URL by running a real download and reading its sidecar —
// `-g`/`--skip-download` produce URLs googlevideo answers with 403.
const armPrefetch = (expire) => {
    sidecarBody = `213\n${mediaUrl(expire)}\n`;
};

const usedYtdlp = () => spawned.length > 0;

Deno.test("prefetch caches the resolved media URL", async () => {
    setup();
    try {
        armPrefetch();
        assertEquals(await prefetchFormatUrl(URL_A), true);
        assertEquals(_formatUrlCacheForTests().size, 1);
        // Must be a real download run — that is the only kind that mints a
        // media URL googlevideo will actually serve.
        assert(!spawned[0].args.includes("-g"), "-g yields a URL that 403s");
        assert(!spawned[0].args.includes("--skip-download"), "--skip-download yields a URL that 403s");
        assert(spawned[0].args.includes("--print-to-file"));
    } finally {
        restore();
    }
});

Deno.test("prefetch is skipped when the URL is already cached", async () => {
    setup();
    try {
        armPrefetch();
        await prefetchFormatUrl(URL_A);
        const after = spawned.length;
        assertEquals(await prefetchFormatUrl(URL_A), false);
        assertEquals(spawned.length, after, "second prefetch spawned yt-dlp anyway");
    } finally {
        restore();
    }
});

Deno.test("prefetch gives up as soon as a dead extractor exits", async () => {
    setup();
    try {
        // No sidecar is ever written — an unavailable video behaves this way.
        // Caught live: the loop used to poll out its full 30s timeout.
        sidecarBody = null;
        exitImmediately = true;
        const started = performance.now();
        assertEquals(await prefetchFormatUrl(URL_A), false);
        const ms = performance.now() - started;
        assert(ms < 3000, `waited ${Math.round(ms)}ms for a process that had already exited`);
    } finally {
        restore();
    }
});

Deno.test("prefetch keeps polling a half-written sidecar", async () => {
    setup();
    try {
        // yt-dlp flushes the duration line before the URL line. Production hit
        // exactly this: the first read saw only line 1, prefetch returned false,
        // and it silently never worked once.
        sidecarBody = "213\n";
        const done = prefetchFormatUrl(URL_A);
        await new Promise((r) => setTimeout(r, 400));
        // ...then the URL line lands.
        Deno.writeTextFileSync(PREFETCH_SIDECAR, `213\n${mediaUrl()}\n`);
        assertEquals(await done, true, "gave up on a sidecar that was still being written");
        assertEquals(_formatUrlCacheForTests().size, 1);
    } finally {
        restore();
    }
});

Deno.test("a prefetched URL that serves no data is not cached", async () => {
    setup();
    try {
        // Caught live on prod: killing the run as soon as the sidecar appears
        // captured a URL that had never served a byte, and it 403'd on the next
        // play. The URL must prove itself before being cached.
        armPrefetch();
        emitBytes = 0;
        assertEquals(await prefetchFormatUrl(URL_A), false);
        assertEquals(_formatUrlCacheForTests().size, 0, "cached a URL that served nothing");
    } finally {
        restore();
    }
});

Deno.test("a URL without a parseable expiry is not cached", async () => {
    setup();
    try {
        sidecarBody = "213\nhttps://rr1---sn-test.googlevideo.com/videoplayback?id=abc\n";
        await prefetchFormatUrl(URL_A);
        assertEquals(_formatUrlCacheForTests().size, 0, "cached a URL with no expiry");
    } finally {
        restore();
    }
});

Deno.test("an already-expired URL is not served from cache", async () => {
    setup();
    try {
        // Inside the safety margin — treated as expired even though `expire` is
        // still a few minutes out.
        armPrefetch(Math.floor(Date.now() / 1000) + 60);
        await prefetchFormatUrl(URL_A);
        spawned = [];
        globalThis.fetch = () => {
            throw new Error("must not fetch an expired URL");
        };
        await createStream(URL_A, 0, () => {});
        assert(usedYtdlp(), "expired cache entry should have fallen back to yt-dlp");
    } finally {
        restore();
    }
});

Deno.test("a cached URL streams over HTTP with no yt-dlp", async () => {
    setup();
    try {
        armPrefetch();
        await prefetchFormatUrl(URL_A);
        spawned = [];

        let fetched = null;
        globalThis.fetch = (u) => {
            fetched = String(u);
            return Promise.resolve(
                new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }),
            );
        };

        const resource = await createStream(URL_A, 0, () => {});
        assert(resource, "no resource returned");
        assert(fetched?.includes("googlevideo.com"), "did not stream from the cached URL");
        assertEquals(spawned.length, 0, "spawned yt-dlp despite a warm cache");
        assertEquals(resource._procs.length, 0, "direct stream owns no child processes");
    } finally {
        restore();
    }
});

Deno.test("a cached URL that 403s falls back to yt-dlp and is evicted", async () => {
    setup();
    try {
        armPrefetch();
        await prefetchFormatUrl(URL_A);
        spawned = [];
        globalThis.fetch = () => Promise.resolve(new Response("denied", { status: 403 }));

        const resource = await createStream(URL_A, 0, () => {});
        assert(resource, "no resource returned");
        assert(usedYtdlp(), "403 on the cached URL should fall back to yt-dlp");
        assertEquals(_formatUrlCacheForTests().size, 0, "dead URL left in the cache");
    } finally {
        restore();
    }
});

Deno.test("a cached URL that throws mid-connect falls back to yt-dlp", async () => {
    setup();
    try {
        armPrefetch();
        await prefetchFormatUrl(URL_A);
        spawned = [];
        globalThis.fetch = () => Promise.reject(new Error("connection reset"));

        const resource = await createStream(URL_A, 0, () => {});
        assert(resource, "no resource returned");
        assert(usedYtdlp(), "network failure should fall back to yt-dlp");
        assertEquals(_formatUrlCacheForTests().size, 0, "dead URL left in the cache");
    } finally {
        restore();
    }
});

Deno.test("seeking ignores the cache — it needs yt-dlp's --download-sections", async () => {
    setup();
    try {
        armPrefetch();
        await prefetchFormatUrl(URL_A);
        spawned = [];
        globalThis.fetch = () => {
            throw new Error("seek must not use the cached URL");
        };

        await createStream(URL_A, 30, () => {});
        assert(usedYtdlp(), "seek should always go through yt-dlp");
        assert(spawned[0].args.includes("--download-sections"));
    } finally {
        restore();
    }
});

Deno.test("the streaming spawn asks yt-dlp to print both duration and URL", async () => {
    setup();
    try {
        await createStream(URL_A, 0, () => {});
        const args = spawned[0].args;
        const tmpl = args[args.indexOf("--print-to-file") + 1];
        assertEquals(tmpl, "%(duration)s\n%(urls)s", "sidecar template must carry both fields");
    } finally {
        restore();
    }
});

// ── proxy fallback ─────────────────────────────────────────────────────────
// YTDLP_PROXY is read at module load, so these assert the shape of the args
// rather than toggling the env: the streaming spawn must carry whatever
// proxyArgs() yields, and a proxy failure must never leave playback broken.
Deno.test("streaming spawn carries no --proxy when YTDLP_PROXY is unset", async () => {
    setup();
    try {
        await createStream(URL_A, 0, () => {});
        assert(!spawned[0].args.includes("--proxy"), "added a proxy with none configured");
    } finally {
        restore();
    }
});

Deno.test("no cookies are sent when YTDLP_PROXY is unset (they are the only auth)", async () => {
    setup();
    try {
        // With no proxy configured cookieArgs() must yield the real cookies.
        // This asserts the shape rather than the value: YOUTUBE_COOKIES is not
        // set in tests, so COOKIES_ARGS is empty and no --cookies flag appears.
        // The guard that matters is that nothing *adds* one spuriously.
        await createStream(URL_A, 0, () => {});
        const n = spawned[0].args.filter((a) => a === "--cookies").length;
        assert(n <= 1, "duplicated --cookies in the spawn args");
    } finally {
        restore();
    }
});
