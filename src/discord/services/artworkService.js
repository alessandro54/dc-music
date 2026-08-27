import { searchTrack } from "@/discord/services/spotifyService.js";
import { log } from "@/lib/logger.js";

// Square album art for a track that only has a video thumbnail.
//
// YouTube serves 4:3/16:9 thumbnails, so a square album cover arrives padded
// with black bars — that is what the Now Playing embed was showing. Spotify's
// album images are square 640x640 and it already holds our credentials, so it is
// the one provider for both paths (Spotify-sourced songs carry their art
// already; this covers everything else).
//
// Measured: 400-670ms warm. That is affordable inside /play's 2s
// acknowledge budget for a single track, and deliberately NOT done per track for
// a playlist — 100 lookups would be 100 requests for art nobody has looked at.

const CACHE_MAX = 500;
const cache = new Map();

// Spotify matches on text, so the video title has to lose its packaging first:
// "Radiohead - Exit Music (For A Film) [Official Video] HD" searches badly.
// Qualifiers that mean a different recording (live, remix, acoustic) are kept —
// they should steer the match, not be discarded.
// A bracketed group is dropped when it mentions packaging AND doesn't name a
// distinct recording — matching on *contains* rather than equals, because
// "(Official 4K Music Video)" interleaves the two.
const NOISE = /\b(?:official|lyrics?|visuali[sz]er|audio|video|hd|hq|4k|uhd|mv|remaster(?:ed)?|explicit)\b/i;
const KEEP = /\b(?:live|remix|acoustic|cover|instrumental|demo|session|edit|version|mix|feat\.?|ft\.?)\b/i;

export function artworkQuery(title) {
    return String(title ?? "")
        .replace(/[([][^()[\]]*[)\]]/g, (group) => (NOISE.test(group) && !KEEP.test(group) ? "" : group))
        // Bare trailing tags that were never bracketed: "… Exit Music HD".
        .replace(/(?:\s+(?:hd|hq|4k|uhd|official|audio|video|lyrics?))+\s*\.?\s*$/i, "")
        .replace(/\s*[-–|]\s*$/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// Returns a square image URL, or null when there's no confident answer. Never
// throws and never outlives its deadline: artwork is decoration, and /play must
// not get slower — let alone fail — over a cover image.
export async function findAlbumArt(title, { timeoutMs = 1200 } = {}) {
    const query = artworkQuery(title);
    if (!query) return null;
    if (cache.has(query)) return cache.get(query);

    let timer;
    try {
        const res = await Promise.race([
            searchTrack(query),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("artwork timeout")), timeoutMs);
            }),
        ]);
        const images = res?.tracks?.items?.[0]?.album?.images ?? [];
        // images[0] is the largest Spotify offers (640x640). A genuine "Spotify
        // doesn't have this" is cached as null so a replay doesn't ask again.
        const url = images[0]?.url ?? null;
        remember(query, url);
        return url;
    } catch (err) {
        // NOT cached. A timeout or a transient 5xx says nothing about the track,
        // and the first lookup after a restart pays for the OAuth token fetch on
        // top of the search — caching that would blank this cover permanently.
        log.warn(`[artwork] ${query}: ${err.message}`);
        return null;
    } finally {
        // The deadline keeps ticking after an early answer or failure otherwise
        // — harmless in prod, but it fails any test under the timer sanitizer.
        clearTimeout(timer);
    }
}

function remember(query, url) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(query, url);
}

export function _clearArtworkCache() {
    cache.clear();
}
