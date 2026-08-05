// Covers the duration path that lets a playing track avoid a second yt-dlp:
// the streaming spawn writes `%(duration)s` to a sidecar file, and backfill
// only spawns when nothing cheaper has filled the duration in.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import {
    _awaitFirstByte,
    _resetShutdownForTests,
    backfillDuration,
    createStream,
    destroyResource,
    fetchPlaylistItems,
    shutdownStreams,
} from "../../src/services/music/stream.js";

const URL_A = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VIDEO_ID = "dQw4w9WgXcQ";
const SIDECAR = `/tmp/yt-duration-${VIDEO_ID}.txt`;

const realCommand = Deno.Command;
let spawned = [];

// When true, spawned procs never exit on their own — they only end when killed,
// which is how a hung yt-dlp behaves.
let hang = false;
// Bytes the fake yt-dlp writes to stdout. 0 = an extraction that produced no
// audio, which createStream must reject rather than hand to the player.
let emitBytes = 4096;

// Stand-in for a spawned yt-dlp/ffmpeg: records its argv and the signals it was
// sent, produces an empty stdout stream and no stderr, and exits successfully.
class FakeCommand {
    constructor(cmd, opts) {
        this.cmd = cmd;
        this.opts = opts;
        this.record = { cmd, args: opts.args ?? [], signals: [], exited: false };
        spawned.push(this.record);
    }
    spawn() {
        const record = this.record;
        let settle;
        const status = hang
            ? new Promise((r) => {
                settle = r;
            })
            : Promise.resolve({ success: true, code: 0, signal: null });
        if (!hang) record.exited = true;
        return {
            // createStream now proves audio is flowing before handing back a
            // resource, so a fake extraction has to emit some.
            stdout: new ReadableStream({
                start(c) {
                    if (emitBytes) c.enqueue(new Uint8Array(emitBytes));
                    c.close();
                },
            }),
            stdin: new WritableStream(),
            stderr: (async function* () {})(),
            status,
            output: () => status.then(() => FakeCommand._payload()),
            kill(signal) {
                record.signals.push(signal);
                record.exited = true;
                settle?.({ success: false, code: null, signal });
            },
        };
    }
    output() {
        return this.spawn().output();
    }
    static _payload() {
        return {
            code: 0,
            stdout: new TextEncoder().encode(JSON.stringify({ title: "Fake", duration: 125, id: VIDEO_ID })),
            stderr: new Uint8Array(),
        };
    }
}

function stubCommands() {
    spawned = [];
    hang = false;
    emitBytes = 4096;
    _resetShutdownForTests();
    Deno.Command = FakeCommand;
}

function restore() {
    Deno.Command = realCommand;
    hang = false;
    try {
        Deno.removeSync(SIDECAR);
    } catch { /* already gone */ }
}

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

Deno.test("createStream without a duration callback asks for no sidecar", async () => {
    stubCommands();
    try {
        await createStream(URL_A);
        assertEquals(spawned.length, 1);
        assert(!spawned[0].args.includes("--print-to-file"), "should not ask yt-dlp to print a duration");
    } finally {
        restore();
    }
});

Deno.test("createStream reports the duration the streaming extraction printed", async () => {
    stubCommands();
    hang = true; // a streaming yt-dlp lives for the whole track
    try {
        let reported = null;
        await createStream(URL_A, 0, (d) => {
            reported = d;
        });

        const args = spawned[0].args;
        // Two lines now: the duration, then the media URL for the format cache.
        assertEquals(argAfter(args, "--print-to-file"), "%(duration)s\n%(urls)s");
        assertEquals(args[args.indexOf("--print-to-file") + 2], SIDECAR);

        // yt-dlp writes the file a second or two into the extraction.
        await Deno.writeTextFile(SIDECAR, "213\n");

        assert(await waitFor(() => reported !== null), "duration callback never fired");
        assertEquals(reported, "3:33");
        // The sidecar is consumed, not left in /tmp for the next play to re-read.
        assert(await waitFor(async () => !(await Deno.stat(SIDECAR).catch(() => null))), "sidecar file was not cleaned up");
    } finally {
        restore();
    }
});

Deno.test("createStream ignores a sidecar that holds no usable duration", async () => {
    stubCommands();
    hang = true; // a streaming yt-dlp lives for the whole track
    try {
        let reported = null;
        await createStream(URL_A, 0, (d) => {
            reported = d;
        });
        await Deno.writeTextFile(SIDECAR, "NA\n");
        await new Promise((r) => setTimeout(r, 700));
        assertEquals(reported, null, "'NA' is not a duration");
    } finally {
        restore();
    }
});

Deno.test("createStream starts fresh — a stale sidecar is not read as this play's duration", async () => {
    stubCommands();
    hang = true; // a streaming yt-dlp lives for the whole track
    try {
        await Deno.writeTextFile(SIDECAR, "999\n");
        let reported = null;
        await createStream(URL_A, 0, (d) => {
            reported = d;
        });
        await new Promise((r) => setTimeout(r, 700));
        assertEquals(reported, null, "left-over file from an earlier play must be cleared at spawn");
    } finally {
        restore();
    }
});

Deno.test("seek still transcodes through ffmpeg, and still gets a duration", async () => {
    stubCommands();
    try {
        await createStream(URL_A, 30, () => {});
        assertEquals(spawned.length, 2);
        assertStringIncludes(spawned[0].cmd, "yt-dlp");
        assertEquals(spawned[1].cmd, "ffmpeg");
        assertEquals(argAfter(spawned[0].args, "--download-sections"), "*30-inf");
        assert(spawned[0].args.includes("--print-to-file"));
    } finally {
        restore();
    }
});

Deno.test("destroying a resource stops the duration poller", async () => {
    stubCommands();
    hang = true; // a streaming yt-dlp lives for the whole track
    try {
        let reported = null;
        const resource = await createStream(URL_A, 0, (d) => {
            reported = d;
        });

        await destroyResource(resource);
        // The track is gone; a duration written afterwards must not be applied
        // to a song that already left the queue.
        await Deno.writeTextFile(SIDECAR, "213\n");
        await new Promise((r) => setTimeout(r, 900));
        assertEquals(reported, null, "poller outlived the resource it belonged to");
    } finally {
        restore();
    }
});

Deno.test("a hung metadata call is tracked and reaped, not left running", async () => {
    stubCommands();
    hang = true;
    try {
        // The real deadline is 60s for playlists — too slow to wait out here, so
        // this drives the same kill path via shutdown with a proc that never exits.
        // What it proves: the proc is registered, signalled, and reaped.
        const pending = fetchPlaylistItems(URL_A, 10);
        await new Promise((r) => setTimeout(r, 50));
        assertEquals(spawned.length, 1);

        await shutdownStreams();
        assert(spawned[0].signals.length > 0, "hung yt-dlp was never signalled");
        assert(spawned[0].exited, "hung yt-dlp was never reaped");
        await pending.catch(() => {});
    } finally {
        restore();
    }
});

Deno.test("shutdown reaps a running stream", async () => {
    stubCommands();
    hang = true;
    try {
        await createStream(URL_A, 0, () => {});
        assertEquals(spawned.length, 1);
        await shutdownStreams();
        assertEquals(spawned[0].signals[0], "SIGTERM");
        assert(spawned[0].exited);
    } finally {
        restore();
    }
});

Deno.test("shutdown cancels a backfill still inside its delay", async () => {
    stubCommands();
    try {
        const song = { url: URL_A, duration: null };
        const done = backfillDuration(song);
        await new Promise((r) => setTimeout(r, 100)); // mid-delay
        await shutdownStreams();
        await done;
        assertEquals(spawned.length, 0, "backfill spawned yt-dlp while shutting down");
        assertEquals(song.duration, null);
    } finally {
        restore();
    }
});

Deno.test("backfillDuration spawns nothing when the duration is already known", async () => {
    stubCommands();
    try {
        await backfillDuration({ url: URL_A, duration: "3:33" });
        assertEquals(spawned.length, 0, "a known duration must not cost a yt-dlp");
    } finally {
        restore();
    }
});

Deno.test("backfillDuration keeps clear of the streaming spawn", async () => {
    stubCommands();
    try {
        // A stream just spawned — the CPU belongs to the track the user is
        // waiting to hear, so no metadata extraction may start alongside it.
        await createStream(URL_A, 0, () => {});
        const spawnsAfterStream = spawned.length;

        const song = { url: URL_A, duration: null };
        const done = backfillDuration(song);

        await new Promise((r) => setTimeout(r, 1500));
        assertEquals(spawned.length, spawnsAfterStream, "backfill spawned while the stream was starting");

        // ...and once the duration arrives for free, the backfill drops entirely.
        song.duration = "2:05";
        await done;
        assertEquals(spawned.length, spawnsAfterStream, "backfill spawned despite the duration arriving first");
    } finally {
        restore();
    }
});

Deno.test("createStream rejects an extraction that produces no audio", async () => {
    stubCommands();
    emitBytes = 0; // extractor ran but never emitted a byte
    try {
        // Without a proxy configured there is no fast path to fall back from,
        // so the single attempt fails and must throw rather than hand the
        // player a silent resource that only the 25s watchdog would catch.
        let threw = null;
        await createStream(URL_A, 0, () => {}).catch((e) => {
            threw = e.message;
        });
        assertEquals(threw, "stream produced no audio");
    } finally {
        restore();
    }
});

// The replay property is tested against the helper directly: routing it through
// createStream means going through @discordjs/voice, which wraps the stream in
// its own transcoding pipeline and never hands back the raw bytes.
Deno.test("_awaitFirstByte replays the chunk it peeked, then the rest", async () => {
    const chunks = [new Uint8Array(100).fill(1), new Uint8Array(50).fill(2)];
    const src = new ReadableStream({
        start(c) {
            for (const ch of chunks) c.enqueue(ch);
            c.close();
        },
    });
    const neverExits = { status: new Promise(() => {}) };

    const out = await _awaitFirstByte(src, neverExits);
    assert(out, "rejected a stream that produced bytes");

    let total = 0;
    const reader = out.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
    }
    // 150, not 50: dropping the peeked chunk would silently truncate the start
    // of every track.
    assertEquals(total, 150, "peeked chunk was not replayed");
});

Deno.test("_awaitFirstByte gives up when the extractor exits without audio", async () => {
    const src = new ReadableStream({ start: (c) => c.close() });
    const exited = { status: Promise.resolve({ success: false, code: 1, signal: null }) };
    assertEquals(await _awaitFirstByte(src, exited), null);
});
