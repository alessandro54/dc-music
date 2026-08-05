import { queues } from "@/discord/services/playbackService.js";

// Snapshot of runtime health for the /debug command. Note: rss is the deno
// process only — yt-dlp/ffmpeg children are separate processes, so `streams`
// (count of live child procs) is the better signal for the OOM/leak story.
export function getHealth(client) {
    const mem = Deno.memoryUsage();
    let streams = 0;

    const guildStats = [...queues.entries()].map(([guildId, q]) => {
        const procs = q.resource?._procs?.length ?? 0;
        streams += procs;
        return {
            guildId,
            state: q.player.state.status, // idle | buffering | playing | paused | autopaused
            current: q.current?.title ?? null,
            queued: q.songs.length,
            voice: q.connection?.state?.status ?? "none",
            procs,
        };
    });

    return {
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        uptimeS: Math.round(performance.now() / 1000),
        ping: client.ws.ping,
        guilds: guildStats,
        streams,
    };
}
