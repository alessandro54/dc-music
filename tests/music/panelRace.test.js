// The live panel is one message per guild — and it was briefly two: refreshes
// overlap (channel.send takes a round-trip, and _start / metadata / artwork
// each fire onChange within milliseconds), so two callers both saw
// `message: null` and both sent. These pin the serialization that prevents it.
import { assert, assertEquals } from "@std/assert";

const { attachPanel, clearPanel, refreshPanel } = await import(
    "@/discord/services/nowPlayingService.js"
);

let ids = 0;
function fakeChannel(sendDelayMs = 20) {
    const events = [];
    const channel = {
        id: "chan",
        events,
        send(payload) {
            const m = {
                id: `m${++ids}`,
                payload,
                edit: (p) => {
                    events.push(`edit:${m.id}`);
                    m.payload = p;
                    return Promise.resolve(m);
                },
                delete: () => {
                    events.push(`delete:${m.id}`);
                    return Promise.resolve();
                },
            };
            // The round-trip is the race window: the message exists only after it.
            return new Promise((resolve) =>
                setTimeout(() => {
                    events.push(`send:${m.id}`);
                    resolve(m);
                }, sendDelayMs)
            );
        },
    };
    return channel;
}

function fakeQueue(guildId) {
    const song = {
        title: "youtu.be/x",
        url: "https://www.youtube.com/watch?v=x",
        duration: null,
        thumbnail: null,
        requestedBy: "t",
        requestedById: "1",
    };
    return {
        guildId,
        songs: [song],
        current: song,
        played: [],
        playing: true,
        resource: { playbackDuration: 0 },
        seekOffset: 0,
        connection: { joinConfig: { channelId: "v" } },
        player: { state: { status: "playing" } },
    };
}

Deno.test("an onChange burst produces one panel, not one per landing", async () => {
    const queue = fakeQueue("race-1");
    const channel = fakeChannel(20);
    attachPanel(queue, channel);
    // The real shape of a /play: start, then metadata lands, then artwork lands,
    // each mutating the song and firing a refresh — all inside one send RTT.
    const first = refreshPanel(queue);
    queue.current.title = "Real Title";
    queue.current.duration = "3:36";
    const second = refreshPanel(queue);
    queue.current.thumbnail = "https://art/640.jpg";
    const third = refreshPanel(queue);
    await Promise.all([first, second, third]);

    let sends = channel.events.filter((e) => e.startsWith("send:"));
    assertEquals(sends.length, 1, `overlapping refreshes must coalesce, not stack: ${channel.events}`);

    // A landing that arrives after the panel exists edits it in place.
    queue.current.title = "Corrected Title";
    await refreshPanel(queue);
    sends = channel.events.filter((e) => e.startsWith("send:"));
    assertEquals(sends.length, 1, "a later change must edit, never re-send");
    assert(channel.events.some((e) => e.startsWith("edit:")), "the later change still renders");
    await clearPanel("race-1");
});

Deno.test("a queue destroyed mid-send still deletes the message it sent", async () => {
    const queue = fakeQueue("race-2");
    const channel = fakeChannel(30);
    attachPanel(queue, channel);
    const inflight = refreshPanel(queue); // send takes 30ms
    await new Promise((r) => setTimeout(r, 5)); // the send is now in flight
    await clearPanel("race-2"); // destroy lands mid-send
    await inflight;
    const sends = channel.events.filter((e) => e.startsWith("send:"));
    const deletes = channel.events.filter((e) => e.startsWith("delete:"));
    assertEquals(sends.length, 1);
    assertEquals(deletes.length, 1, `the landed message must not be orphaned: ${channel.events}`);
});
