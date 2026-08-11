import { getInnertube } from "@/discord/services/innertubeService.js";
import { getSongMeta } from "@/discord/services/trackService.js";
import {
    cacheArgs,
    cookieArgs,
    dec,
    ejsArgs,
    FULL_EXTRACT_ARGS,
    META_ARGS,
    potArgs,
    runYtdlp,
    shutdownSignal,
    sleep,
} from "@/discord/services/ytdlpService.js";
import { log } from "@/lib/logger.js";
import { extractVideoId, fmtSecs, isYouTubeUrl, ytThumb } from "@/lib/media.js";

// Title / duration / artwork for a URL, and the playlist listing. Everything here
// is read-only lookup — the audio itself is streamService's job.

// Metadata is immutable per video, so a plain Map keyed by id is enough. Capped
// so a long-lived process can't grow it without bound.
const META_CACHE_MAX = 500;
const metaCache = new Map();

function cacheMeta(videoId, info) {
    if (metaCache.size >= META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
    metaCache.set(videoId, info);
    return info;
}

// The streaming extraction reports the duration it parsed (streamService's
// sidecar poller) — fold it into the cache so the next play of the same video
// gets it for free.
export function cacheDuration(videoId, duration) {
    const cached = metaCache.get(videoId);
    if (cached) cached.duration = duration;
}

export function clearMetaCache() {
    metaCache.clear();
}

// A metadata call that hasn't answered in this long is never going to — and an
// unbounded one holds the /play interaction open until Discord expires it.
const METADATA_TIMEOUT_MS = 20_000;
const PLAYLIST_TIMEOUT_MS = 60_000;
const INNERTUBE_TIMEOUT_MS = 1500;

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]);
}

// oEmbed is unauthenticated and — unlike Innertube's `getBasicInfo` — not
// bot-gated on this datacenter IP (measured: 37ms, HTTP 200, where yt-dlp
// takes 4-5s). No duration in the payload, so that gets backfilled.
async function _oembedVideoInfo(url, videoId) {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`oembed ${res.status}`);
    const j = await res.json();
    if (!j.title) throw new Error("oembed returned no title");
    return { title: j.title, url, duration: null, thumbnail: j.thumbnail_url ?? ytThumb(videoId) };
}

// Anything played before already has its title and duration stored.
async function _dbVideoInfo(url, videoId) {
    const known = await getSongMeta(url);
    if (!known?.title) throw new Error("not in history");
    return { title: known.title, url, duration: known.duration ?? null, thumbnail: ytThumb(videoId) };
}

// In-process Innertube — when it isn't bot-gated it returns title and duration
// together in ~60ms. On this IP most videos come back LOGIN_REQUIRED with no
// title, so it's a lucky fast path, not the primary one. It has no built-in
// deadline, so cap it: a hung session must not hold up the sources that answer.
async function _innertubeVideoInfo(url, videoId) {
    const info = await withTimeout(
        getInnertube().then((yt) => yt.getBasicInfo(videoId)),
        INNERTUBE_TIMEOUT_MS,
        "innertube",
    );
    const title = info.basic_info?.title;
    if (!title) throw new Error("innertube returned no title");
    const duration = info.basic_info?.duration;
    return { title, url, duration: duration ? fmtSecs(duration) : null, thumbnail: ytThumb(videoId) };
}

export async function fetchVideoInfo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error("invalid YouTube URL");

    const cached = metaCache.get(videoId);
    if (cached) return cached;

    // The three cheap sources run concurrently rather than in a chain: each one
    // fails often enough on this IP (DB miss, Innertube LOGIN_REQUIRED, oEmbed
    // 404 on unlisted) that chaining them makes every play pay the sum of the
    // misses. Raced, a play costs the *fastest* source that answers.
    const started = performance.now();
    let won = false;
    const sources = [
        ["db", _dbVideoInfo(url, videoId)],
        ["innertube", _innertubeVideoInfo(url, videoId)],
        ["oembed", _oembedVideoInfo(url, videoId)],
    ];
    try {
        const info = await Promise.any(sources.map(([name, p]) =>
            p.then((r) => {
                // Losers still settle — only the first one to answer is the cost.
                if (!won) {
                    log.info(`[stream] metadata via ${name} in ${Math.round(performance.now() - started)}ms`);
                }
                won = true;
                return r;
            })
        ));
        return cacheMeta(videoId, info);
    } catch (err) {
        // AggregateError — every fast source missed.
        const reasons = err.errors?.map((e, i) => `${sources[i][0]}: ${e.message}`).join("; ") ?? err.message;
        log.warn(`[stream] fast metadata sources failed (${reasons}), falling back to yt-dlp`);
    }

    // Private/unlisted/region-locked — only the cookie-aware extractor can see it.
    const info = await _ytdlpVideoInfo(url, videoId);
    log.info(`[stream] metadata via yt-dlp in ${Math.round(performance.now() - started)}ms`);
    return cacheMeta(videoId, info);
}

// Metadata for a non-YouTube URL. There is no race here on purpose: the DB /
// Innertube / oEmbed sources above are all YouTube-only, so yt-dlp is the single
// source of truth and the only cost is its ~2s extraction.
export async function fetchTrackInfo(url) {
    return await _dumpJson(url, null, []);
}

// yt-dlp metadata fallback — used when the cache, the DB, Innertube and oEmbed
// all come up empty (private/unlisted/region-locked), and for duration backfill.
// Retries with the full streaming arg set, which sees whatever playback can see.
async function _ytdlpVideoInfo(url, videoId) {
    try {
        return await _dumpJson(url, videoId, META_ARGS);
    } catch (err) {
        log.warn(`[stream] fast metadata failed, retrying with full args: ${err.message}`);
        return _dumpJson(url, videoId, FULL_EXTRACT_ARGS());
    }
}

async function _dumpJson(url, videoId, extraArgs) {
    const { code, stdout, stderr } = await runYtdlp([
        "--no-playlist",
        "--dump-json",
        "--quiet",
        "--no-warnings",
        "--skip-download",
        ...cookieArgs(),
        ...cacheArgs(),
        ...extraArgs,
        url,
    ], { timeoutMs: METADATA_TIMEOUT_MS, what: "yt-dlp metadata" });
    const out = dec.decode(stdout).trim();
    if (code !== 0 || !out) {
        throw new Error(`incomplete video info: ${dec.decode(stderr).trim() || "yt-dlp returned nothing"}`);
    }
    const v = JSON.parse(out.split("\n")[0]);
    if (!v.title) throw new Error("incomplete video info");
    return {
        title: v.title,
        url,
        duration: fmtSecs(v.duration ?? 0),
        // Non-YouTube sources carry their own artwork; ytThumb would invent a
        // youtube URL from a foreign id and 404.
        thumbnail: isYouTubeUrl(url) ? ytThumb(videoId ?? v.id) : (v.thumbnail ?? null),
    };
}

export async function fetchPlaylistItems(url, limit) {
    const { code, stdout, stderr } = await runYtdlp([
        "--flat-playlist",
        "--dump-json",
        "--quiet",
        "--no-warnings",
        ...cookieArgs(),
        ...cacheArgs(),
        ...potArgs(),
        ...ejsArgs(),
        "--playlist-end",
        String(limit),
        url,
    ], { timeoutMs: PLAYLIST_TIMEOUT_MS, what: "yt-dlp playlist" });
    const out = dec.decode(stdout);
    if (code !== 0 && !out.trim()) {
        throw new Error(`yt-dlp playlist failed (${code}): ${dec.decode(stderr).trim()}`);
    }
    return out.trim().split("\n").filter(Boolean).map((line) => {
        try {
            const v = JSON.parse(line);
            return {
                title: v.title,
                url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
                duration: fmtSecs(v.duration || 0),
                thumbnail: v.thumbnails?.[0]?.url ?? (isYouTubeUrl(url) ? ytThumb(v.id) : null),
            };
        } catch {
            return null;
        }
    }).filter(Boolean);
}

// ── duration backfill ──────────────────────────────────────────────────────
// Backfill spawns yt-dlp, which on this box is the single most expensive thing
// the bot does. Playback spawns its own yt-dlp moments later — measured on the
// 2-core host, a backfill running across a streaming spawn delayed audio by 6.9s
// (15:09 in the prod log: 0.9s to enqueue, then 6.9s of nothing). So backfills
// are serialised with each other and kept clear of the streaming spawn.
//
// The minimum delay is what makes the grace window work: backfill is kicked from
// the resolver, *before* the track is enqueued and the stream spawns, so without
// it the grace check reads a stale timestamp and runs straight into the spawn.
const BACKFILL_MIN_DELAY_MS = 2000;
const BACKFILL_STREAM_GRACE_MS = 8000;
let _lastStreamSpawn = 0;
let _backfillChain = Promise.resolve();

// streamService reports its spawns here so a queued backfill can stay out of
// their way.
export function noteStreamSpawn() {
    _lastStreamSpawn = Date.now();
}

// Fill in a duration the fast paths couldn't provide, off the critical path.
// Mutates the queued song in place so /np and /queue pick it up on next render.
export function backfillDuration(song) {
    const videoId = extractVideoId(song.url);
    if (!videoId || song.duration) return _backfillChain;

    _backfillChain = _backfillChain.then(async () => {
        // Waits are abortable: a shutdown mid-delay must not spawn yt-dlp on
        // the way out, and the sleep must not hold the process open either.
        const signal = shutdownSignal();
        try {
            await sleep(BACKFILL_MIN_DELAY_MS, signal);
            const wait = _lastStreamSpawn + BACKFILL_STREAM_GRACE_MS - Date.now();
            if (wait > 0) await sleep(wait, signal);
        } catch {
            return; // shutting down
        }
        // Re-check only now: the whole point of waiting is that something
        // cheaper usually answers first — the playing track's own extraction
        // prints its duration, or an earlier backfill in this chain filled it.
        if (song.duration || signal.aborted) return;
        try {
            // Single attempt: the full-args retry costs another ~3.8s of yt-dlp
            // for a number that only decorates an embed. If the cheap client
            // can't see the video, leave the duration blank.
            const info = await _dumpJson(song.url, videoId, META_ARGS);
            song.duration = info.duration;
            cacheDuration(videoId, info.duration);
        } catch (err) {
            log.warn(`[stream] duration backfill failed for ${song.url}: ${err.message}`);
        }
    });
    return _backfillChain;
}
