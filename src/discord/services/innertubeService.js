import { Innertube } from "youtubei.js";

import { UserFacingError } from "@/lib/errors.js";
import { fmtSecs, ytThumb } from "@/lib/media.js";

// In-process YouTube client. Search is the only thing it is reliably good for on
// this IP — see metadataService for why getBasicInfo is a lucky fast path rather
// than the primary metadata source.

let _yt = null;

export async function getInnertube() {
    if (_yt) return _yt;
    _yt = await Innertube.create({ retrieve_player: false, generate_session_locally: true });
    return _yt;
}

// ── search cache ───────────────────────────────────────────────────────────
// Discord fires an autocomplete event on *every keystroke*, and each one was a
// live Innertube round-trip: measured 414-516ms each, with a repeat of the same
// query costing full price. Typing one song title meant a dozen of them on a
// 2-core box, so the suggestions ran several characters behind the typing.
//
// Search results for a query are stable for minutes, which makes this the one
// place a plain TTL cache is exactly right.
// Cached at full width and sliced per caller, so autocomplete's 5 and the
// /play fallback's 1 share one entry instead of missing each other.
const SEARCH_WIDTH = 10;
const SEARCH_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX = 300;
const searchCache = new Map();
// Two keystrokes can be in flight at once, and the second must not open its own
// round-trip for a query the first is already fetching.
const inflight = new Map();

const norm = (query) => query.trim().toLowerCase().replace(/\s+/g, " ");

function remember(key, videos) {
    // Insertion-ordered, so the oldest key is the first one out. A miss costs a
    // round-trip, not correctness, which is why this doesn't track use.
    if (searchCache.size >= SEARCH_CACHE_MAX) {
        searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(key, { at: Date.now(), videos });
}

function fresh(key) {
    const hit = searchCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > SEARCH_TTL_MS) {
        searchCache.delete(key);
        return null;
    }
    return hit.videos;
}

// Answer *now* or not at all — an autocomplete has one response and a late one
// is discarded, so the caller needs to know synchronously whether it can skip
// the network.
export const peekSearch = (query, limit = 5) => fresh(norm(query))?.slice(0, limit) ?? null;

// The results already held for the longest cached prefix of this query. Typing
// forward narrows a result set rather than replacing it, so the previous
// keystroke's answer is a good enough *instant* answer while the exact one is
// fetched for the keystroke after. Short prefixes are excluded: "ba" and
// "bad bunny" genuinely have nothing to do with each other.
const MIN_PREFIX = 4;

export function peekSearchPrefix(query, limit = 5) {
    const key = norm(query);
    let best = null;
    for (const cached of searchCache.keys()) {
        if (cached.length < MIN_PREFIX || cached.length >= key.length) continue;
        if (!key.startsWith(cached)) continue;
        if (!best || cached.length > best.length) best = cached;
    }
    return best ? (fresh(best)?.slice(0, limit) ?? null) : null;
}

// The client is created once and reused; tests swap in a stub so the cache can
// be exercised without reaching YouTube.
export function _setInnertubeForTests(client) {
    _yt = client;
}

export function _resetSearchCacheForTests() {
    searchCache.clear();
    inflight.clear();
}

export async function searchVideos(query, limit = 5) {
    const key = norm(query);
    const cached = fresh(key);
    if (cached) return cached.slice(0, limit);

    const pending = inflight.get(key) ?? _search(key, query);
    inflight.set(key, pending);
    try {
        return (await pending).slice(0, limit);
    } finally {
        inflight.delete(key);
    }
}

async function _search(key, query) {
    const yt = await getInnertube();
    const results = await yt.search(query, { type: "video" });
    const videos = (results.videos ?? []).slice(0, SEARCH_WIDTH).map((video) => ({
        title: String(video.title?.text ?? video.title ?? query),
        url: `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration?.text ?? fmtSecs(video.duration?.seconds ?? 0),
        thumbnail: video.thumbnails?.[0]?.url ?? ytThumb(video.id),
    }));
    // An empty result is cached too — a query YouTube has nothing for is worth
    // remembering, or every further keystroke re-asks the same dead question.
    remember(key, videos);
    return videos;
}

export async function searchVideo(query) {
    const [first] = await searchVideos(query, 1);
    if (!first) throw new UserFacingError(`No results for **${query}**.`);
    return first;
}
