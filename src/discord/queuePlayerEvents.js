import { AudioPlayerStatus } from "@discordjs/voice";

import { forceDirectStreams } from "@/discord/services/ytdlpService.js";
import { TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";
import { captureError, captureWarn } from "@/lib/sentry.js";

// The AudioPlayer state machine for one GuildQueue: what happens on each
// transition (buffering too long, first audio, track ended, player error).
//
// It is GuildQueue's own logic, split out because inline in the constructor it
// was 110 lines and the transitions were impossible to find — so these functions
// touch queue internals on purpose. The split is by *reason to change*: this
// file changes when playback transitions change, guildQueue.js when the queue's
// shape or commands do.

export function attachPlayerEvents(queue) {
    const { player } = queue;
    player.on(AudioPlayerStatus.Buffering, () => onBuffering(queue));
    player.on(AudioPlayerStatus.Playing, () => onPlaying(queue));
    player.on(AudioPlayerStatus.Idle, () => onIdle(queue));
    player.on("error", (err) => onError(queue, err));
}

// Stall watchdog: yt-dlp can be slow to first byte (or hang silently) on a
// datacenter IP, leaving the player stuck in Buffering with no error and no
// progress. If it buffers too long, skip to the next track.
function onBuffering(queue) {
    clearTimeout(queue._stallTimeout);
    queue._stallTimeout = setTimeout(() => onStalled(queue), TIMEOUTS.STREAM_STALL_MS);
}

function onStalled(queue) {
    // The fast path (proxy, no cookies) is ~95% reliable — measured 18 of 19 —
    // and a stream has no retry of its own, so the 1 in 20 would die silently.
    // Before giving up on the track, force the slow-but-authenticated path and
    // play it again. Only once: a second stall is a genuinely bad track, not a
    // flaky path.
    if (!queue._stallRetried && forceDirectStreams()) {
        queue._stallRetried = true;
        log.warn(`[Queue ${queue.guildId}] Stream stalled — retrying ${queue.current?.title} with cookies`);
        queue._killStream();
        queue._playNext();
        return;
    }
    log.error(
        `[Queue ${queue.guildId}] Stream stalled (buffering > ${TIMEOUTS.STREAM_STALL_MS}ms), skipping`,
    );
    captureWarn("Stream stalled while buffering", {
        tags: { stage: "stall", guild: queue.guildId },
        extra: {
            title: queue.current?.title,
            url: queue.current?.url,
            stallMs: TIMEOUTS.STREAM_STALL_MS,
            retried: queue._stallRetried,
        },
    });
    queue.player.stop(); // → Idle → advance
}

function onPlaying(queue) {
    clearTimeout(queue._stallTimeout);
    queue._stallRetried = false;
    // Time to first audio — the number the user actually waits through. `spawn`
    // only covers forking yt-dlp; the extraction that follows (player JS, nsig,
    // PO token, first bytes) is the real cost and was previously invisible.
    if (queue._streamStartedAt !== null) {
        log.music(log.gray(`audio in ${Math.round(performance.now() - queue._streamStartedAt)}ms`));
        queue._streamStartedAt = null;
    }
}

function onIdle(queue) {
    clearTimeout(queue._stallTimeout);
    // A seek killed its own stream and is about to play the same track from
    // the new offset — this Idle is the kill's echo, not the track ending.
    // Shifting here is what made a seek eat the song (and with it the queue).
    if (queue._seeking) return;
    queue._killStream();
    queue.seekOffset = 0;
    queue._stallRetried = false;
    // `previous()` already put the track to play at the front and does not want
    // it consumed — the stop() it fires to interrupt the current track lands
    // here first.
    if (queue._replaying) {
        queue._replaying = false;
        queue._playNext();
        return;
    }
    const finished = queue.songs.shift();
    if (finished) queue._remember(finished);
    queue._advance();
}

function onError(queue, err) {
    log.error(`[Queue ${queue.guildId}] Player error: ${err.message}`);
    captureError(err, {
        tags: { stage: "player", guild: queue.guildId },
        extra: { title: queue.current?.title, url: queue.current?.url },
    });
    queue._killStream();
    // A track that errored never played, so it is dropped rather than remembered
    // — /previous should not offer to replay a failure.
    queue.songs.shift();
    queue._advance({ idleTimer: false });
}
