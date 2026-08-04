import { Readable } from "node:stream";
import { createAudioResource, StreamType } from "@discordjs/voice";
import { Innertube } from "youtubei.js";
import { getSongMeta } from "../../lib/db.js";
import { log } from "../../lib/logger.js";
import { captureError } from "../../lib/sentry.js";

const YTDLP = Deno.env.get("YTDLP_PATH") || `${import.meta.dirname}/yt-dlp`;

let COOKIES_ARGS = [];
function writeCookies(text) {
    Deno.writeTextFileSync("/tmp/yt-cookies.txt", text);
    COOKIES_ARGS = ["--cookies", "/tmp/yt-cookies.txt"];
}

const cookies = Deno.env.get("YOUTUBE_COOKIES");
if (cookies) {
    try {
        writeCookies(cookies);
        log.info("[stream] YouTube cookies loaded");
    } catch (err) {
        log.error(`[stream] Failed to write cookies: ${err.message}`);
    }
}

// Hot-swap cookies at runtime (see commands/setcookies.js). Takes effect on
// the next yt-dlp call — no restart needed — but doesn't persist: the host's
// YOUTUBE_COOKIES config var still wins on the next deploy/restart.
export function reloadCookies(text) {
    writeCookies(text);
    log.info("[stream] YouTube cookies reloaded (live only — update YOUTUBE_COOKIES on the host to persist)");
}

let CACHE_ARGS = [];
try {
    Deno.mkdirSync("/data/ytdlp-cache", { recursive: true });
    CACHE_ARGS = ["--cache-dir", "/data/ytdlp-cache"];
} catch { /* /data not available in local dev */ }

// bgutil PO-token provider — when YTDLP_POT_BASE_URL points at the provider
// sidecar, yt-dlp's bgutil plugin fetches PO tokens to bypass YouTube bot
// detection on datacenter IPs (no cookies needed).
let POT_ARGS = [];
const potBaseUrl = Deno.env.get("YTDLP_POT_BASE_URL");
if (potBaseUrl) {
    POT_ARGS = ["--extractor-args", `youtubepot-bgutilhttp:base_url=${potBaseUrl}`];
    log.info(`[stream] PO-token provider → ${potBaseUrl}`);
}

// YouTube signature / n-sig challenge solver. yt-dlp fetches the EJS solver
// script from GitHub (cached after first use) and runs it via the bundled deno
// runtime — without it YouTube returns only image formats, no audio.
const EJS_ARGS = ["--remote-components", "ejs:github"];

// Force PO-token fetching, but let yt-dlp pick the client.
// - No player_client pin: YouTube enabled the SABR-only streaming experiment
//   on this account's `tv` client (formats come back with no URLs — see
//   https://github.com/yt-dlp/yt-dlp/issues/12482), so pinning tv yields
//   "Requested format is not available". yt-dlp ≥ 2026.07.04 keeps the PO
//   token and format URL on the same client in the default set (it used to
//   mismatch → 403, which is why tv was pinned), so the default set is safe
//   again and falls through to a client that still serves DASH opus (251).
// - fetch_pot=always: some clients skip the PO token by default, but some
//   videos' GVS URLs require one → 403. Forcing it makes bgutil always mint
//   the player + gvs tokens.
const CLIENT_ARGS = ["--extractor-args", "youtube:fetch_pot=always"];

const AUDIO_FMT = "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=opus]/bestaudio";
const dec = new TextDecoder();

let _yt = null;
async function getInnertube() {
    if (_yt) return _yt;
    _yt = await Innertube.create({ retrieve_player: false, generate_session_locally: true });
    return _yt;
}

function extractVideoId(url) {
    return url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
}

// Derive a cover image from the video id — always exists, no extra API call.
function ytThumb(videoId) {
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
}

function fmtSecs(s) {
    s = Math.floor(s);
    const m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0
        ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
        : `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Metadata is immutable per video, so a plain Map keyed by id is enough. Capped
// so a long-lived process can't grow it without bound.
const META_CACHE_MAX = 500;
const metaCache = new Map();

function cacheMeta(videoId, info) {
    if (metaCache.size >= META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
    metaCache.set(videoId, info);
    return info;
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

export async function fetchVideoInfo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error("invalid YouTube URL");

    const cached = metaCache.get(videoId);
    if (cached) return cached;

    // Anything played before already has its title and duration in the DB.
    const known = await getSongMeta(url);
    if (known?.title) {
        return cacheMeta(videoId, {
            title: known.title,
            url,
            duration: known.duration ?? null,
            thumbnail: ytThumb(videoId),
        });
    }

    // In-process Innertube first — when it isn't bot-gated it returns title and
    // duration together in ~60ms. On this IP most videos come back
    // LOGIN_REQUIRED with no title, so treat it as a lucky fast path, not the
    // primary one.
    try {
        const yt = await getInnertube();
        const info = await yt.getBasicInfo(videoId);
        const title = info.basic_info?.title;
        const duration = info.basic_info?.duration;
        if (title) {
            return cacheMeta(videoId, {
                title,
                url,
                duration: duration ? fmtSecs(duration) : null,
                thumbnail: ytThumb(videoId),
            });
        }
    } catch (err) {
        log.warn(`[stream] Innertube getBasicInfo failed: ${err.message}`);
    }

    try {
        return cacheMeta(videoId, await _oembedVideoInfo(url, videoId));
    } catch (err) {
        log.warn(`[stream] oEmbed failed, falling back to yt-dlp: ${err.message}`);
    }

    // Private/unlisted/region-locked — only the cookie-aware extractor can see it.
    return cacheMeta(videoId, await _ytdlpVideoInfo(url, videoId));
}

// Fill in a duration the fast paths couldn't provide, off the critical path.
// Mutates the queued song in place so /np and /queue pick it up on next render.
export async function backfillDuration(song) {
    const videoId = extractVideoId(song.url);
    if (!videoId || song.duration) return;
    try {
        const info = await _ytdlpVideoInfo(song.url, videoId);
        song.duration = info.duration;
        const cached = metaCache.get(videoId);
        if (cached) cached.duration = info.duration;
    } catch (err) {
        log.warn(`[stream] duration backfill failed for ${song.url}: ${err.message}`);
    }
}

// Metadata needs a title and a duration — not a playable format URL. Pinning a
// single lightweight client and skipping the player JS avoids yt-dlp probing
// clients one by one, and --ignore-no-formats-error keeps it from bailing when
// that client serves no usable format. Measured on the prod IP: 1.4-1.8s vs
// 3.8s for the full streaming arg set, same title and duration.
const META_ARGS = [
    "--ignore-no-formats-error",
    "--extractor-args", "youtube:player_client=ios;player_skip=js",
];

// yt-dlp metadata fallback — used when the cache, the DB, Innertube and oEmbed
// all come up empty (private/unlisted/region-locked), and for duration backfill.
// Retries with the full streaming arg set, which sees whatever playback can see.
async function _ytdlpVideoInfo(url, videoId) {
    try {
        return await _dumpJson(url, videoId, META_ARGS);
    } catch (err) {
        log.warn(`[stream] fast metadata failed, retrying with full args: ${err.message}`);
        return _dumpJson(url, videoId, [...POT_ARGS, ...EJS_ARGS, ...CLIENT_ARGS]);
    }
}

async function _dumpJson(url, videoId, extraArgs) {
    const { code, stdout, stderr } = await new Deno.Command(YTDLP, {
        args: [
            "--no-playlist", "--dump-json", "--quiet", "--no-warnings", "--skip-download",
            ...COOKIES_ARGS, ...CACHE_ARGS, ...extraArgs,
            url,
        ],
        stdout: "piped",
        stderr: "piped",
    }).output();
    const out = dec.decode(stdout).trim();
    if (code !== 0 || !out) throw new Error(`incomplete video info: ${dec.decode(stderr).trim() || "yt-dlp returned nothing"}`);
    const v = JSON.parse(out.split("\n")[0]);
    if (!v.title) throw new Error("incomplete video info");
    return { title: v.title, url, duration: fmtSecs(v.duration ?? 0), thumbnail: ytThumb(videoId ?? v.id) };
}

export async function searchVideos(query, limit = 5) {
    const yt = await getInnertube();
    const results = await yt.search(query, { type: "video" });
    return (results.videos ?? []).slice(0, limit).map((video) => ({
        title: String(video.title?.text ?? video.title ?? query),
        url: `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration?.text ?? fmtSecs(video.duration?.seconds ?? 0),
        thumbnail: video.thumbnails?.[0]?.url ?? ytThumb(video.id),
    }));
}

export async function searchVideo(query) {
    const [first] = await searchVideos(query, 1);
    if (!first) throw new Error(`no results for "${query}"`);
    return first;
}

export async function fetchPlaylistItems(url, limit) {
    const { code, stdout, stderr } = await new Deno.Command(YTDLP, {
        args: [
            "--flat-playlist", "--dump-json", "--quiet", "--no-warnings", ...COOKIES_ARGS, ...CACHE_ARGS, ...POT_ARGS, ...EJS_ARGS,
            "--playlist-end", String(limit),
            url,
        ],
        stdout: "piped",
        stderr: "piped",
    }).output();
    const out = dec.decode(stdout);
    if (code !== 0 && !out.trim()) throw new Error(`yt-dlp playlist failed (${code}): ${dec.decode(stderr).trim()}`);
    return out.trim().split("\n").filter(Boolean).map((line) => {
        try {
            const v = JSON.parse(line);
            return {
                title: v.title,
                url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
                duration: fmtSecs(v.duration || 0),
                thumbnail: ytThumb(v.id),
            };
        } catch { return null; }
    }).filter(Boolean);
}

export async function createStream(url, seekSeconds = 0) {
    return _ytdlpStream(url, seekSeconds);
}

// Tear down a resource and reap its child procs. SIGTERM first so yt-dlp can
// propagate the signal to any ffmpeg child it spawned (--download-sections),
// then SIGKILL if it hasn't exited. Awaiting .status reaps the process and
// releases its stdio pipes — without this, killed procs leak as zombies.
export async function destroyResource(resource) {
    if (!resource) return;
    // Close the output stream so child stdout pipes receive EOF.
    try {
        resource.playStream?.destroy();
    } catch { /* already gone */ }

    await Promise.all((resource._procs ?? []).map(async (proc) => {
        try {
            proc.kill("SIGTERM");
        } catch { /* already exited */ }
        const exited = await Promise.race([
            proc.status.then(() => true).catch(() => true),
            new Promise((r) => setTimeout(() => r(false), 2000)),
        ]);
        if (!exited) {
            try {
                proc.kill("SIGKILL");
            } catch { /* race: exited between checks */ }
            try {
                await proc.status;
            } catch { /* already reaped */ }
        }
    }));
}

function _ytdlpStream(url, seekSeconds) {
    const args = [
        "--no-playlist", "-o", "-", "--quiet", "--no-warnings", "--no-check-formats",
        // Transient googlevideo 403s: retry the download and re-run the
        // extractor (fresh media URL) before giving up on the track.
        "--retries", "5", "--fragment-retries", "5", "--extractor-retries", "3",
        // Fail a dead/stalled connection fast instead of hanging the stream.
        "--socket-timeout", "15",
        ...COOKIES_ARGS, ...CACHE_ARGS, ...POT_ARGS, ...EJS_ARGS, ...CLIENT_ARGS,
    ];

    if (seekSeconds > 0) {
        args.push(
            "-f", "bestaudio/best",
            "--download-sections", `*${seekSeconds}-inf`,
            "--force-keyframes-at-cuts",
        );
    } else {
        args.push("-f", AUDIO_FMT);
    }

    args.push(url);

    const ytdlp = new Deno.Command(YTDLP, { args, stdout: "piped", stderr: "piped" }).spawn();
    // The stream is handed back before yt-dlp has produced a byte, so a failed
    // extraction never throws here — it surfaces as a silent track (the stall
    // watchdog skips it). Drain stderr and report a non-zero exit so the actual
    // cause (expired cookies, 403, format gone) lands in Sentry instead of
    // scrolling past in the logs.
    (async () => {
        const tail = [];
        for await (const chunk of ytdlp.stderr) {
            const msg = dec.decode(chunk).trim();
            if (!msg) continue;
            log.error(`[yt-dlp] ${msg}`);
            tail.push(msg);
            if (tail.length > 20) tail.shift();
        }
        const status = await ytdlp.status.catch(() => null);
        // A signal means we killed it (skip/stop/seek) — expected, not an error.
        if (!status || status.success || status.signal) return;
        captureError(new Error(`yt-dlp exited ${status.code}: ${tail[tail.length - 1] ?? "no stderr"}`), {
            tags: { stage: "ytdlp", exitCode: String(status.code) },
            extra: { url, seekSeconds, stderr: tail.join("\n") },
        });
    })();

    if (seekSeconds > 0) {
        const ffmpeg = new Deno.Command("ffmpeg", {
            args: [
                "-threads", "1", "-i", "pipe:0",
                "-vn", "-acodec", "libopus", "-b:a", "96k",
                "-ar", "48000", "-ac", "2", "-f", "opus", "pipe:1",
            ],
            stdin: "piped",
            stdout: "piped",
            stderr: "null",
        }).spawn();
        ytdlp.stdout.pipeTo(ffmpeg.stdin).catch(() => {});
        const resource = createAudioResource(Readable.fromWeb(ffmpeg.stdout), { inputType: StreamType.Arbitrary });
        resource._procs = [ytdlp, ffmpeg];
        return resource;
    }

    const resource = createAudioResource(Readable.fromWeb(ytdlp.stdout), { inputType: StreamType.WebmOpus });
    resource._procs = [ytdlp];
    return resource;
}
