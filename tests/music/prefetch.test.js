// Next-track prefetch: the gap between songs should be a player state flip,
// not a ~7s extraction. These drive the three lifecycle rules — a matching
// prefetch is played, a stale one is reaped, and the window check spawns the
// extraction early — against a stubbed spawn, no network.
import { assert, assertEquals } from "@std/assert";

const { GuildQueue } = await import("@/discord/guildQueue.js");
const { _resetShutdownForTests } = await import("@/discord/services/streamService.js");

const realCommand = Deno.Command;
let spawned = [];

class FakeCommand {
    constructor(cmd, opts) {
        spawned.push({ cmd, args: opts.args ?? [] });
    }
    spawn() {
        let settle;
        const status = new Promise((r) => {
            settle = r;
        });
        return {
            stdout: new ReadableStream({
                start(c) {
                    c.enqueue(new Uint8Array(4096));
                    c.close();
                },
            }),
            stdin: new WritableStream(),
            stderr: (async function* () {})(),
            status,
            output: () => status.then(() => ({ code: 0, stdout: new Uint8Array() })),
            kill(signal) {
                settle?.({ success: false, code: null, signal });
            },
        };
    }
}

const NoSpawn = class {
    constructor() {
        throw new Error("this path must not spawn");
    }
};

// The player is replaced with a recorder: these tests drive the queue's own
// methods, not audio.
function bareQueue() {
    const queue = new GuildQueue("prefetch-test", {});
    queue.player = {
        played: [],
        play(resource) {
            this.played.push(resource);
        },
        stop() {},
        pause() {},
        unpause() {},
        on() {},
        state: { status: "playing" },
    };
    return queue;
}

const mkSong = (title) => ({
    title,
    url: `https://www.youtube.com/watch?v=${title}`,
    duration: "3:00",
    thumbnail: null,
    requestedBy: "t",
    requestedById: "1",
    spotifyTrack: null,
});

function fakeResource() {
    return { playbackDuration: 0, playStream: { destroy() {} }, _procs: [] };
}

Deno.test("a matching prefetch plays without spawning", async () => {
    Deno.Command = NoSpawn;
    const queue = bareQueue();
    try {
        const song = mkSong("aaa");
        queue.songs = [song];
        const held = fakeResource();
        queue._next = { song, resource: held };
        await queue._playNext();
        assertEquals(queue.player.played.length, 1);
        assert(queue.player.played[0] === held, "must play the held resource");
        assertEquals(queue._next, null, "the handoff consumes the slot");
    } finally {
        queue.destroy();
        Deno.Command = realCommand;
    }
});

Deno.test("a reordered queue reaps the stale prefetch instead of playing it", () => {
    const queue = bareQueue();
    try {
        const held = fakeResource();
        let torndown = false;
        held.playStream = {
            destroy() {
                torndown = true;
            },
        };
        queue._next = { song: mkSong("old-next"), resource: held };
        const got = queue._takePrefetch(mkSong("now-first"));
        assertEquals(got, null, "a stale extraction must never play out of order");
        assertEquals(queue._next, null);
        // destroyResource tears down in the background; one macrotask is enough
        // for the stubbed teardown to run.
        return new Promise((r) =>
            setTimeout(() => {
                assert(torndown, "the stale resource must be reaped");
                r();
            }, 5)
        );
    } finally {
        queue.destroy();
    }
});

Deno.test({
    name: "inside the lead window the next track is extracted early",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        _resetShutdownForTests();
        spawned = [];
        Deno.Command = FakeCommand;
        const queue = bareQueue();
        try {
            queue.playing = true;
            queue.songs = [mkSong("current"), mkSong("next-up")];
            queue.resource = { playbackDuration: 160_000 }; // 2:40 into a 3:00 track
            await queue._maybePrefetch();
            assert(spawned.length >= 1, "the window check must spawn the extraction");
            assert(queue._next, "the extracted resource is held");
            assertEquals(queue._next.song.title, "next-up");
        } finally {
            queue.destroy();
            Deno.Command = realCommand;
        }
    },
});

Deno.test({
    name: "outside the window, or with nothing queued, nothing spawns",
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        Deno.Command = NoSpawn;
        const queue = bareQueue();
        try {
            queue.playing = true;
            queue.songs = [mkSong("current"), mkSong("next-up")];
            queue.resource = { playbackDuration: 10_000 }; // 0:10 into 3:00 — 170s left
            await queue._maybePrefetch();
            assertEquals(queue._next, null);
            queue.resource = { playbackDuration: 160_000 };
            queue.songs = [mkSong("current")]; // window open but nothing behind it
            await queue._maybePrefetch();
            assertEquals(queue._next, null);
        } finally {
            queue.destroy();
            Deno.Command = realCommand;
        }
    },
});

Deno.test("destroy reaps a held prefetch", () => {
    const queue = bareQueue();
    let torndown = false;
    const held = fakeResource();
    held.playStream = {
        destroy() {
            torndown = true;
        },
    };
    queue._next = { song: mkSong("x"), resource: held };
    queue.destroy();
    return new Promise((r) =>
        setTimeout(() => {
            assert(torndown, "destroy must not leak the held extraction");
            r();
        }, 5)
    );
});
