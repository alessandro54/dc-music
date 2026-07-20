import { Readable } from "node:stream";
import { createAudioResource, StreamType } from "@discordjs/voice";
import { Innertube } from "youtubei.js";
import { log } from "../../lib/logger.js";

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

export async function fetchVideoInfo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error("invalid YouTube URL");

    // Fast path: in-process Innertube (no subprocess). On datacenter IPs
    // (e.g. Oracle Cloud) YouTube bot-detection can return a video with no
    // title — fall back to the cookie-aware yt-dlp path that streaming uses.
    try {
        const yt = await getInnertube();
        const info = await yt.getBasicInfo(videoId);
        const title = info.basic_info?.title;
        if (title) {
            return { title, url, duration: fmtSecs(info.basic_info?.duration ?? 0), thumbnail: ytThumb(videoId) };
        }
    } catch (err) {
        log.warn(`[stream] Innertube getBasicInfo failed, falling back to yt-dlp: ${err.message}`);
    }
    return _ytdlpVideoInfo(url, videoId);
}

// yt-dlp metadata fallback — same extractor + cookies as playback, so it works
// whenever streaming does.
async function _ytdlpVideoInfo(url, videoId) {
    const { code, stdout, stderr } = await new Deno.Command(YTDLP, {
        args: [
            "--no-playlist", "--dump-json", "--quiet", "--no-warnings", "--skip-download",
            ...COOKIES_ARGS, ...CACHE_ARGS, ...POT_ARGS, ...EJS_ARGS, ...CLIENT_ARGS,
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
    (async () => {
        for await (const chunk of ytdlp.stderr) {
            const msg = dec.decode(chunk).trim();
            if (msg) log.error(`[yt-dlp] ${msg}`);
        }
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
