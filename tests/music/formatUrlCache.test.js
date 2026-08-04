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

class FakeCommand {
    constructor(cmd, opts) {
        this.record = { cmd, args: opts.args ?? [], signals: [] };
        spawned.push(this.record);
    }
    spawn() {
        const record = this.record;
        const sidecarPath = record.args[record.args.indexOf("--print-to-file") + 2];
        if (sidecarBody !== null && sidecarPath) {
            Deno.writeTextFileSync(sidecarPath, sidecarBody);
        }
        // A streaming yt-dlp runs until killed — status settles only on kill,
        // which is what lets reap() complete.
        let settle;
        const status = new Promise((r) => {
            settle = r;
        });
        return {
            stdout: new ReadableStream({ start: (c) => c.close() }),
            stdin: new WritableStream(),
            stderr: (async function* () {})(),
            status,
            output: () => Promise.resolve(this._payload()),
            kill(signal) {
                record.signals.push(signal);
                settle({ success: false, code: null, signal });
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
