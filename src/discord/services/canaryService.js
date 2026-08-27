import { queues } from "@/discord/services/playbackService.js";
import { probeExtraction } from "@/discord/services/streamService.js";
import { PLAYER_CLIENTS } from "@/discord/services/ytdlpService.js";
import { TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";
import { captureError } from "@/lib/sentry.js";

// Does YouTube extraction still work *at all*?
//
// This exists because of 2026-08-18: YouTube stopped serving playable audio to
// the pinned player client and every play failed for ~17 hours, while every
// signal the bot has said it was fine. `/health` returned 200, Discord stayed
// connected, the cookie watch reported a live session — all true, and all
// irrelevant, because none of them touch the extraction. A human noticing was
// the detection mechanism.
//
// So the canary probes the one thing those checks miss: it runs the real
// streaming path against a known-good video and waits for a first byte. It is
// the difference between finding out in 30 minutes and finding out tomorrow.

// A video that has to stay playable for the probe to mean anything: old, famous,
// not region-locked, extremely unlikely to be taken down. If it ever *is*, the
// canary reports broken extraction while playback is fine — hence the override,
// so that is a config change rather than a deploy.
const CANARY_VIDEO_ID = Deno.env.get("CANARY_VIDEO_ID") || "dQw4w9WgXcQ";
const CANARY_URL = `https://www.youtube.com/watch?v=${CANARY_VIDEO_ID}`;

let watch = null;
// null, not true: nothing is known until the first probe, so the first result is
// a baseline rather than a transition. Starting at `true` would mean a bot that
// boots into an outage never reports it.
let lastOk = null;

// `probe` is injectable so the transition logic can be tested without spawning
// yt-dlp — that logic is the whole product here, and it is the part that would
// rot silently.
async function _tick(client, probe = probeExtraction) {
    // Playback is sequential for a reason — 2 cores means a second extraction
    // directly delays the audio someone is waiting on (measured: 6.9s). A probe
    // is never worth that, and a guild that is playing right now is live proof
    // extraction works anyway, so skip rather than compete.
    for (const queue of queues.values()) {
        if (queue.current) return;
    }

    const { ok, ms } = await probe(CANARY_URL);
    if (ok === lastOk) return;

    const first = lastOk === null;
    lastOk = ok;

    if (ok) {
        // Only interesting as a recovery. On the first tick it is the baseline,
        // and "extraction works" is not news worth a line every boot.
        if (!first) {
            log.info(`[canary] YouTube extraction works again (${ms}ms)`);
            await _notify(client, "✅ YouTube extraction is working again — playback should be back.");
        }
        return;
    }

    const detail = `player_client=${PLAYER_CLIENTS.primary} produced no audio in ${ms}ms`;
    log.error(`[canary] YouTube extraction is broken — ${detail}`);
    captureError(new Error(`extraction canary failed: ${detail}`), {
        tags: { stage: "canary", clients: PLAYER_CLIENTS.primary },
        extra: { url: CANARY_URL },
    });
    await _notify(
        client,
        `🚨 **YouTube extraction is broken.** Every \`/play\` will fail.\n` +
            `\`${detail}\`\n` +
            `Likely a YouTube-side client change. Sweep clients and re-pin with ` +
            `\`dokku config:set music-bot YTDLP_PLAYER_CLIENTS=…\` — no deploy needed.`,
    );
}

// A failed alert must never take the bot down, and must not be silent either —
// an alert channel that quietly stopped working is the same failure as having no
// alert at all, just harder to notice.
async function _notify(client, content) {
    const ownerId = Deno.env.get("OWNER_ID");
    if (!ownerId) return void log.warn("[canary] no OWNER_ID set — alert has nowhere to go");
    try {
        const owner = await client.users.fetch(ownerId);
        await owner.send(content);
    } catch (err) {
        log.error(`[canary] could not DM the owner: ${err.message}`);
        captureError(err, { tags: { stage: "canary", step: "notify" } });
    }
}

// `firstDelayMs` keeps the probe clear of boot: the first play after a restart is
// already the slowest one (cold yt-dlp cache, cold Spotify token), and racing it
// with a probe on 2 cores is exactly the interference this is supposed to avoid.
export function startCanary(client, { everyMs = TIMEOUTS.CANARY_CHECK_MS, firstDelayMs = 120_000 } = {}) {
    if (watch) return;
    const run = () => _tick(client).catch((err) => log.warn(`[canary] probe failed: ${err.message}`));
    watch = { timer: setTimeout(run, firstDelayMs), interval: null };
    watch.interval = setInterval(run, everyMs);
}

export const _tickForTests = _tick;

export function stopCanary() {
    if (watch) {
        clearTimeout(watch.timer);
        clearInterval(watch.interval);
        watch = null;
    }
    // Reset unconditionally: the baseline belongs to a *run*, so a stopped canary
    // that starts again must re-establish it rather than trust what it knew
    // before the gap — during which anything could have changed.
    lastOk = null;
}
