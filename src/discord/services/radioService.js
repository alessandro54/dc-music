import { getInnertube, searchVideos } from "@/discord/services/innertubeService.js";
import { LIMITS, TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";
import { fmtSecs, ytThumb } from "@/lib/media.js";
import { captureError } from "@/lib/sentry.js";

// Track discovery: seed video ids in, similar tracks out. Separate from
// innertubeService (the client + search) because it changes for a different
// reason — that file changes when the Innertube client does, this one when what
// counts as a good suggestion does.
//
// The source is YouTube Music's automix queue (`music.getUpNext`). Measured
// against 4 real prod video ids: 50 items per seed in 740-950ms, the seed itself
// always at index 0, and ~49 *new* ids per additional seed — four seeds pooled to
// 195 unique tracks with the genre held. Two alternatives were measured and
// rejected: `getInfo().watch_next_feed` returned 20 nodes with zero playable
// video ids, and `music.getRelated` is faster (360ms) but returns 41 items whose
// nodes carry no duration, so it is only the fallback's fallback.
//
// Nodes arrive fully populated — title, duration.seconds, author, thumbnail — so
// a radio track needs neither a yt-dlp metadata call nor a duration backfill.

// Seeds are fetched concurrently. That does not violate the one-yt-dlp-at-a-time
// rule the audio pipeline lives by: this is HTTP against Innertube, no subprocess
// and no CPU on a 2-core box, so the cost of 5 seeds is the slowest one, not the
// sum. Sequential would be ~4s and overrun the interaction.
export async function radioFrom(seeds, { limit = LIMITS.RADIO_TRACKS, exclude = new Set() } = {}) {
    if (!seeds.length) return [];

    const settled = await Promise.allSettled(
        seeds.map((seed) => withDeadline(upNext(seed.id), TIMEOUTS.RADIO_SEED_MS)),
    );

    // Round-robin across seeds rather than draining the first one. Five tracks
    // off one seed is that seed's radio; one track off each is the guild's.
    const lists = settled.map((r) => (r.status === "fulfilled" ? r.value ?? [] : []));
    const failed = settled.length - lists.filter((l) => l.length).length;
    if (failed) log.warn(`[radio] ${failed}/${seeds.length} seeds returned nothing`);

    const picked = interleave(lists, exclude, limit);
    if (picked.length) return picked;

    // Every seed came back empty. On this IP that is the expected shape of an
    // Innertube gate, and a radio that silently returns nothing is
    // indistinguishable from a guild with no history — so fall back to search,
    // which is the one Innertube call known to work here.
    log.warn("[radio] no automix results for any seed — falling back to search");
    return await searchFallback(seeds, exclude, limit);
}

async function upNext(videoId) {
    const yt = await getInnertube();
    const panel = await yt.music.getUpNext(videoId, true);
    return (panel?.contents ?? [])
        // The seed is always contents[0]; `video_id` also filters out the
        // non-video nodes YouTube mixes into the panel.
        .filter((node) => node.video_id && node.video_id !== videoId)
        .map(trackFrom);
}

function trackFrom(node) {
    const videoId = node.video_id;
    // YouTube Music splits what a video title combines: `title` is the song alone
    // ("lovely", "oficial", "RAIN III") and the artist lives in `author`. Every
    // other source here yields a full video title, so taking `title` on its own
    // made radio rows read as broken next to a /play row. Joined only when the
    // title doesn't already carry the artist — some nodes are titled
    // "Artist - Song" and would otherwise be doubled.
    const title = String(node.title?.text ?? node.title ?? "Unknown");
    const author = node.author ? String(node.author) : null;
    return {
        id: videoId,
        title: author && !title.toLowerCase().includes(author.toLowerCase()) ? `${author} - ${title}` : title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        // `duration` is an object here, unlike search's string — take the text and
        // format the seconds only if it is missing, so views get one shape.
        duration: node.duration?.text ?? (node.duration?.seconds ? fmtSecs(node.duration.seconds) : null),
        thumbnail: node.thumbnail?.[0]?.url ?? ytThumb(videoId),
    };
}

// One from each seed, then the next from each, until full. Skips anything the
// caller already has (the seeds themselves, the live queue, recent plays).
function interleave(lists, exclude, limit) {
    const taken = [];
    const seen = new Set(exclude);
    for (let depth = 0; taken.length < limit; depth++) {
        let advanced = false;
        for (const list of lists) {
            if (depth >= list.length) continue;
            advanced = true;
            const track = list[depth];
            if (seen.has(track.id)) continue;
            seen.add(track.id);
            taken.push(track);
            if (taken.length >= limit) break;
        }
        if (!advanced) break; // every list exhausted
    }
    return taken;
}

// Last resort: search each seed's own title. Worse suggestions — search matches
// words, automix matches taste — but a queue that keeps going beats silence.
async function searchFallback(seeds, exclude, limit) {
    const seen = new Set(exclude);
    const tracks = [];
    for (const seed of seeds) {
        if (tracks.length >= limit || !seed.title) break;
        try {
            const results = await searchVideos(seed.title, 5);
            for (const result of results) {
                const id = result.url.split("v=")[1];
                if (!id || seen.has(id)) continue;
                seen.add(id);
                tracks.push({ id, ...result });
                if (tracks.length >= limit) break;
            }
        } catch (err) {
            // A dead fallback is worth knowing about: it means radio has no
            // working source at all on this host.
            log.error(`[radio] search fallback for "${seed.title}": ${err.message}`);
            captureError(err, { tags: { stage: "radio" }, extra: { seed: seed.title } });
        }
    }
    return tracks;
}

// Radio tracks in queue shape. Shared by /radio's first batch and the station
// refills so the two can't disagree about what a radio song is — the
// viaPlaylist/source pair below is load-bearing in three different places.
export function radioSongs(tracks, requestedBy, requestedById) {
    return tracks.map(({ id: _id, ...track }) => ({
        ...track,
        requestedBy,
        requestedById,
        spotifyTrack: null,
        // Plays, not picks — the same rule a playlist follows. This is what stops
        // the station feeding on itself: radio tracks never become seeds, so it
        // can't drift away from what a human actually chose.
        viaPlaylist: true,
        // Its own source, not "youtube". The audio does come from YouTube, but
        // provenance is what asked for it, and only this tells a machine-picked
        // row from a human one later — which /leaderboard needs.
        source: "radio",
    }));
}

function withDeadline(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`radio seed timed out after ${ms}ms`)), ms)
        ),
    ]);
}
