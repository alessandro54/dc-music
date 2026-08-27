// The enqueue hot path: a suggestion the user picked must resolve from memory —
// no metadata race, no backfill spawn, no awaited artwork. These pin the three
// pieces that make Enter-to-reply a local operation.
import { assert, assertEquals } from "@std/assert";

// Artwork goes through Spotify; credentials must exist so the lookup takes the
// (stubbed) network path instead of failing synchronously before it.
Deno.env.set("SPOTIFY_CLIENT_ID", "test");
Deno.env.set("SPOTIFY_CLIENT_SECRET", "test");

const { clearMetaCache, fetchVideoInfo, primeVideoInfo } = await import(
    "@/discord/services/metadataService.js"
);
const { _resetSearchCacheForTests, _setInnertubeForTests } = await import(
    "@/discord/services/innertubeService.js"
);
const { resolveQuery } = await import("@/discord/resolvers/index.js");

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PICKED = {
    title: "Rick Astley - Never Gonna Give You Up",
    url: URL,
    duration: "3:33",
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
};

const { GuildQueue } = await import("@/discord/guildQueue.js");

const realFetch = globalThis.fetch;
const realCommand = Deno.Command;

// Every network touch is loud: the point of the primed path is that there are
// none. Artwork's fetch is the one caller allowed through — it rejects after
// `artworkDelayMs`, proving the resolver did not wait for it.
function setup({ artworkDelayMs = 0 } = {}) {
    clearMetaCache();
    _resetSearchCacheForTests();
    const touched = [];
    globalThis.fetch = (input) => {
        const url = String(input?.url ?? input);
        touched.push(url);
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error("stubbed network")), artworkDelayMs)
        );
    };
    Deno.Command = class {
        constructor() {
            throw new Error("the primed path must not spawn yt-dlp");
        }
    };
    return touched;
}

function restore() {
    globalThis.fetch = realFetch;
    Deno.Command = realCommand;
    _setInnertubeForTests(null);
}

Deno.test("a primed video resolves from memory — no fetch, no spawn", async () => {
    const touched = setup();
    try {
        primeVideoInfo(PICKED);
        const started = performance.now();
        const info = await fetchVideoInfo(URL);
        const ms = performance.now() - started;
        assertEquals(info.title, PICKED.title);
        assertEquals(info.duration, "3:33");
        assertEquals(touched.length, 0, `expected no network, saw: ${touched.join(", ")}`);
        assert(ms < 50, `memory hit took ${ms}ms`);
    } finally {
        restore();
    }
});

Deno.test("priming never clobbers an existing entry", async () => {
    setup();
    try {
        primeVideoInfo(PICKED);
        primeVideoInfo({ ...PICKED, title: "someone else's label", duration: null });
        assertEquals((await fetchVideoInfo(URL)).title, PICKED.title);
    } finally {
        restore();
    }
});

Deno.test("/play of a picked suggestion replies before artwork answers", async () => {
    // Artwork stalls 200ms; the resolve must come back in a fraction of that,
    // carrying the pending lookup instead of its result. The duration arriving
    // primed is also what keeps backfillDuration from spawning (Deno.Command
    // throws here, so a spawn would fail the test loudly).
    setup({ artworkDelayMs: 200 });
    try {
        primeVideoInfo(PICKED);
        const started = performance.now();
        const { songs } = await resolveQuery(URL, "tester", "1");
        const ms = performance.now() - started;
        assert(ms < 100, `resolve took ${ms}ms — it waited for something`);
        assertEquals(songs[0].title, PICKED.title);
        assertEquals(songs[0].duration, "3:33");
        assert(songs[0]._artwork instanceof Promise, "the artwork lookup should ride on the song");
        assertEquals(await songs[0]._artwork, null, "a failed lookup settles to null, never throws");
    } finally {
        restore();
    }
});

Deno.test("plain text resolves straight off the autocomplete's search cache", async () => {
    setup({ artworkDelayMs: 0 });
    try {
        // The last keystroke's search already cached this query.
        _setInnertubeForTests({
            search: () =>
                Promise.resolve({
                    videos: [{
                        id: "dQw4w9WgXcQ",
                        title: { text: PICKED.title },
                        duration: { seconds: 213 },
                    }],
                }),
        });
        const { searchVideos } = await import("@/discord/services/innertubeService.js");
        await searchVideos("never gonna", 5);
        _setInnertubeForTests({
            search: () => Promise.reject(new Error("submit must not search again")),
        });
        const { songs } = await resolveQuery("never gonna", "tester", "1");
        assertEquals(songs[0].url, URL);
    } finally {
        restore();
    }
});

// oEmbed is the one fast source a pasted URL usually has. `delayMs` controls
// whether it lands inside the resolver's grace period.
function setupOembed(delayMs, touched) {
    globalThis.fetch = (input) => {
        const url = String(input?.url ?? input);
        touched.push(url);
        if (!url.includes("oembed")) return Promise.reject(new Error("stubbed"));
        return new Promise((resolve) =>
            setTimeout(() =>
                resolve({
                    ok: true,
                    json: () => Promise.resolve({ title: "Real Title", thumbnail_url: null }),
                }), delayMs)
        );
    };
    _setInnertubeForTests({ getBasicInfo: () => Promise.reject(new Error("gated")) });
}

Deno.test({
    name: "a pasted URL that oEmbed answers quickly replies with the real title",
    // backfillDuration (oEmbed has no duration) parks a 2s timer; the sanitizer
    // would report it even though shutdown reaps it in production.
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const touched = [];
        setup();
        setupOembed(30, touched);
        try {
            const started = performance.now();
            const { songs } = await resolveQuery(URL, "tester", "1");
            const ms = performance.now() - started;
            assert(ms < 200, `resolve took ${ms}ms`);
            assertEquals(songs[0].title, "Real Title");
        } finally {
            restore();
        }
    },
});

Deno.test({
    name: "a pasted URL nothing answers in time replies with a placeholder, not a wait",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const touched = [];
        setup();
        setupOembed(600, touched); // past the grace period
        try {
            const started = performance.now();
            const { songs } = await resolveQuery(URL, "tester", "1");
            const ms = performance.now() - started;
            assert(ms < 450, `resolve took ${ms}ms — grace period is 250ms`);
            assertEquals(songs[0].title, "youtu.be/dQw4w9WgXcQ", "placeholder until the lookup lands");
            const late = await songs[0]._meta;
            assertEquals(late.title, "Real Title", "the lookup still completes for the queue to absorb");
        } finally {
            restore();
        }
    },
});

Deno.test("the queue absorbs late metadata and artwork into its own copy", async () => {
    const changes = [];
    const queue = new GuildQueue("test-guild", { onChange: () => changes.push(1) });
    queue.playing = true; // keep add() from starting a real stream
    const song = {
        title: "youtu.be/x",
        url: "https://www.youtube.com/watch?v=x",
        duration: null,
        thumbnail: "yt-thumb",
        _meta: Promise.resolve({ title: "Real Title", duration: "3:00" }),
        _artwork: Promise.resolve("https://art/640.jpg"),
    };
    await queue.add(song);
    await new Promise((r) => setTimeout(r, 5)); // let both landings settle
    assertEquals(song.title, "Real Title");
    assertEquals(song.duration, "3:00");
    assertEquals(song.thumbnail, "https://art/640.jpg");
    assert(changes.length >= 2, "each landing must redraw the panel");
});
