// A track the queue could not play has to say so. `/play` posts its Now Playing
// embed at queue time, so a drop that stays quiet leaves an embed for a song
// that never plays and a `/np` that answers "Nothing playing" — which reads as a
// broken bot rather than one bad track.
import { assert, assertEquals } from "@std/assert";

import { GuildQueue } from "@/discord/guildQueue.js";

Deno.test("a dropped track reports the song it dropped", () => {
    const seen = [];
    const queue = new GuildQueue("g1", { onTrackError: (song, err) => seen.push([song, err]) });
    queue.songs = [{ title: "Dead Track", url: "https://youtu.be/x" }, { title: "Next" }];

    queue._dropTrack(new Error("stream produced no audio"), "stream", {});

    assertEquals(seen.length, 1, "the channel was never told");
    assertEquals(seen[0][0].title, "Dead Track", "must name the track that failed, not the next one");
    assertEquals(seen[0][1].message, "stream produced no audio");
    assertEquals(queue.songs.length, 1, "the dead track should be gone");
    assertEquals(queue.songs[0].title, "Next", "the queue keeps moving");
});

Deno.test("a failing notifier does not take the queue down", () => {
    const queue = new GuildQueue("g2", {
        onTrackError: () => {
            throw new Error("channel is gone");
        },
    });
    queue.songs = [{ title: "Dead Track" }];

    queue._dropTrack(new Error("nope"), "stream", {});

    assertEquals(queue.songs.length, 0);
    assert(!queue.playing, "queue should have wound down, not thrown");
});
