import { queues } from "@/discord/services/playbackService.js";
import { shutdownStreams } from "@/discord/services/ytdlpService.js";
import { log } from "@/lib/logger.js";

// Dokku sends SIGTERM on every redeploy. Container teardown would kill the
// whole cgroup anyway, so this isn't about leaked processes — it's about going
// down cleanly: leave the voice channels, stop the players, reap our own yt-dlp
// children rather than having them die mid-write.
export function installShutdownHandlers(client) {
    let shuttingDown = false;
    for (const signal of ["SIGTERM", "SIGINT"]) {
        Deno.addSignalListener(signal, async () => {
            if (shuttingDown) return;
            shuttingDown = true;
            log.info(`${signal} — shutting down`);
            try {
                for (const queue of [...queues.values()]) queue.destroy();
                await shutdownStreams();
                await client.destroy();
            } catch (err) {
                log.error(`shutdown: ${err.message}`);
            }
            Deno.exit(0);
        });
    }
}
