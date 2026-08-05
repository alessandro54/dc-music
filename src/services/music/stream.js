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

// YouTube signature / n-sig challenge solver (EJS), run via the deno already in
// the image — without it YouTube returns only image formats, no audio.
//
// Empty on purpose. The solver now ships in the image as the `yt-dlp-ejs`
// package (Dockerfile installs `yt-dlp[default]`), which yt-dlp picks up on its
// own. `--remote-components ejs:github` is the *alternative* to that package,
// not a companion to it: measured with the package installed, passing the flag
// still fetched from GitHub and cost 9.08s on a cold cache versus 2.06s using
// the local copy. Since the container has no volume, every deploy is a cold
// cache — and a GitHub outage would mean no audio at all.
const EJS_ARGS = [];

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

// Route yt-dlp through a proxy (the WARP sidecar) when YTDLP_PROXY is set.
// This datacenter IP is flagged, which is what makes a cold play expensive:
// YouTube serves a flagged IP no formats at all unless the full anti-bot chain
// runs (watch page → PO token → player JS → nsig solve ≈ 3.7s), and then the
// CDN is slow to first byte. Measured from the same host through WARP, with no
// cookies and no PO token: 1.6-2.1s to first audio versus 7.3s direct.
//
// Unset = direct, exactly as before.
const PROXY = Deno.env.get("YTDLP_PROXY");

// A proxy that breaks must never mean no music. On any proxied failure we fall
// back to a direct call and stop using the proxy for a while — cookies and the
// PO token still work, they are just slower.
const PROXY_COOLDOWN_MS = 5 * 60 * 1000;
let proxyDisabledUntil = 0;

function proxyArgs() {
    if (!PROXY || Date.now() < proxyDisabledUntil) return [];
    return ["--proxy", PROXY];
}

// Cookies are the ~6s tax: an authenticated session makes YouTube demand the
// full player-JS + nsig chain on every play, and sending them through the proxy
// is exactly as slow as sending them direct.
//
// `critical` marks a call whose failure the listener actually hears. Measured
// on fresh videos, the cookie-free proxy path succeeds ~75% of the time — fine
// for prefetch and metadata, which retry or simply fall back, and unacceptable
// for the streaming spawn, where the resource is already handed to the player
// and a failure costs a 25s stall before anything can recover. So streams keep
// their cookies and stay reliable; the fast path is spent where a miss is free.
function cookieArgs({ critical = false } = {}) {
    if (!critical && PROXY && Date.now() >= proxyDisabledUntil) return [];
    return COOKIES_ARGS;
}

// A media URL is minted for whichever egress IP asked for it, so a URL the
// proxy obtained must also be *fetched* through the proxy — otherwise the
// cached-URL path 403s and silently falls back to yt-dlp, which is exactly
// what happened the first time the proxy was switched on.
let _proxyClient = null;
function proxyClient() {
    // Same health gate as proxyArgs(): in cooldown we go direct, and a URL
    // minted through the proxy will then 403 and evict itself, which is the
    // intended fallback rather than a failure.
    if (!PROXY || Date.now() < proxyDisabledUntil) return undefined;
    _proxyClient ??= Deno.createHttpClient({ proxy: { url: PROXY } });
    return _proxyClient;
}

function markProxyBad(reason) {
    if (!PROXY || Date.now() < proxyDisabledUntil) return;
    proxyDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
    log.warn(`[stream] proxy failed (${reason}) — going direct for ${PROXY_COOLDOWN_MS / 60000}min`);
}

if (PROXY) log.info(`[stream] yt-dlp proxy → ${PROXY}`);

const AUDIO_FMT = "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=opus]/bestaudio";
const dec = new TextDecoder();

// ── child process lifecycle ────────────────────────────────────────────────
// Every yt-dlp/ffmpeg this module spawns is registered here. docker-init at PID 1
// does reap orphans (despite tini's warning at boot), but only once they exit —
// a proc that hangs instead of exiting is nobody's problem but ours, and it sits
// there for the container's whole uptime.
const liveProcs = new Set();

// Cancels in-flight waits (backfill delays) at shutdown so nothing spawns on
// the way out.
let _shutdownAC = new AbortController();

function track(proc) {
    liveProcs.add(proc);
    proc.status.finally(() => liveProcs.delete(proc)).catch(() => liveProcs.delete(proc));
    return proc;
}

// SIGTERM, then SIGKILL if it's still there. Awaiting .status is what actually
// reaps the child and releases its stdio pipes.
async function reap(proc, graceMs = 2000) {
    try {
        proc.kill("SIGTERM");
    } catch { /* already exited */ }
    const exited = await Promise.race([
        proc.status.then(() => true).catch(() => true),
        new Promise((r) => setTimeout(() => r(false), graceMs)),
    ]);
    if (exited) return;
    try {
        proc.kill("SIGKILL");
    } catch { /* race: exited between checks */ }
    await proc.status.catch(() => {});
}

const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("aborted"));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(new Error("aborted"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });

// Run a one-shot yt-dlp (metadata / playlist dump) under a hard deadline.
// Deno.Command#output() can't be aborted, so the proc is spawned and raced —
// on timeout it gets killed and reaped rather than left running with a pipe
// nobody reads.
async function runYtdlp(args, { timeoutMs, what }) {
    const viaProxy = proxyArgs();
    const res = await _runYtdlpOnce([...viaProxy, ...args], { timeoutMs, what });
    // A non-zero exit through the proxy is indistinguishable here from a video
    // that is genuinely unavailable, so retry direct and let the caller judge
    // the second result. Costs one extra call on a real failure; keeps a broken
    // proxy from taking playback down with it.
    if (viaProxy.length && res.code !== 0) {
        markProxyBad(`${what} exited ${res.code}`);
        // args were built while the proxy was healthy, so cookieArgs() gave
        // nothing. The direct path is the authenticated one — put them back,
        // otherwise the fallback is strictly weaker than the attempt it
        // replaces and YOUTUBE_COOKIES never does anything.
        const withCookies = COOKIES_ARGS.length && !args.includes("--cookies")
            ? [...COOKIES_ARGS, ...args]
            : args;
        return _runYtdlpOnce(withCookies, { timeoutMs, what });
    }
    return res;
}

async function _runYtdlpOnce(args, { timeoutMs, what }) {
    const proc = track(new Deno.Command(YTDLP, { args, stdout: "piped", stderr: "piped" }).spawn());
    let timer;
    const deadline = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
        return await Promise.race([proc.output(), deadline]);
    } catch (err) {
        await reap(proc);
        if (args.includes("--proxy")) markProxyBad(err.message);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Force the direct, cookie-authenticated path for a while. Called when a
// stream produced no audio: the fast path is flaky at the margins and a
// stalled track has no retry of its own. Returns false when there is nothing
// to fall back from, so callers can skip the retry entirely.
export function forceDirectStreams() {
    if (!PROXY) return false;
    markProxyBad("stream produced no audio");
    return true;
}

// Kill everything this module owns. Called from the shutdown path so a redeploy
// doesn't leave yt-dlp children behind.
export async function shutdownStreams() {
    _shutdownAC.abort();
    const procs = [...liveProcs];
    liveProcs.clear();
    if (procs.length) log.info(`[stream] reaping ${procs.length} child process(es)`);
    await Promise.all(procs.map((p) => reap(p, 1000)));
}

// Tests re-arm the module between cases; production never calls this.
export function _resetShutdownForTests() {
    _shutdownAC = new AbortController();
    liveProcs.clear();
    metaCache.clear();
}

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
                if (!won) log.info(`[stream] metadata via ${name} in ${Math.round(performance.now() - started)}ms`);
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

// Fill in a duration the fast paths couldn't provide, off the critical path.
// Mutates the queued song in place so /np and /queue pick it up on next render.
export function backfillDuration(song) {
    const videoId = extractVideoId(song.url);
    if (!videoId || song.duration) return _backfillChain;

    _backfillChain = _backfillChain.then(async () => {
        // Waits are abortable: a shutdown mid-delay must not spawn yt-dlp on
        // the way out, and the sleep must not hold the process open either.
        const signal = _shutdownAC.signal;
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
            const cached = metaCache.get(videoId);
            if (cached) cached.duration = info.duration;
        } catch (err) {
            log.warn(`[stream] duration backfill failed for ${song.url}: ${err.message}`);
        }
    });
    return _backfillChain;
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

// A metadata call that hasn't answered in this long is never going to — and an
// unbounded one holds the /play interaction open until Discord expires it.
const METADATA_TIMEOUT_MS = 20_000;
const PLAYLIST_TIMEOUT_MS = 60_000;

async function _dumpJson(url, videoId, extraArgs) {
    const { code, stdout, stderr } = await runYtdlp([
        "--no-playlist", "--dump-json", "--quiet", "--no-warnings", "--skip-download",
        ...cookieArgs(), ...CACHE_ARGS, ...extraArgs,
        url,
    ], { timeoutMs: METADATA_TIMEOUT_MS, what: "yt-dlp metadata" });
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
    const { code, stdout, stderr } = await runYtdlp([
        "--flat-playlist", "--dump-json", "--quiet", "--no-warnings", ...cookieArgs(), ...CACHE_ARGS, ...POT_ARGS, ...EJS_ARGS,
        "--playlist-end", String(limit),
        url,
    ], { timeoutMs: PLAYLIST_TIMEOUT_MS, what: "yt-dlp playlist" });
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

// A googlevideo media URL cannot be fetched with a plain GET: the server
// truncates an un-ranged request. Measured on a 4:19 track its clen said
// 4,429,008 bytes while a single fetch returned 622,592, so playback ended a
// few seconds in. yt-dlp downloads in ranged chunks, which is why it is
// correct. A format-URL cache therefore needs a ranged reader, not a fetch —
// until it has one there is no cache, and the cookie-free fast path already
// gets a cold play to ~2s on its own.

// Wait for the stream to actually produce a byte, so a dead extraction is
// caught here instead of surfacing 25s later as a stalled track. Returns a
// stream with that first chunk put back, or null when nothing ever arrived.
const FIRST_BYTE_TIMEOUT_MS = 9000;

export async function _awaitFirstByte(webStream, proc) {
    const reader = webStream.getReader();
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), FIRST_BYTE_TIMEOUT_MS);
    });
    // A failed extractor exits within a couple of seconds; racing its status
    // means we don't sit out the whole budget for a video that is never coming.
    const died = proc.status.then(() => ({ died: true })).catch(() => ({ died: true }));

    let first;
    try {
        first = await Promise.race([reader.read(), deadline, died]);
    } finally {
        clearTimeout(timer);
    }

    if (!first || first.timedOut || first.died || first.done || !first.value?.length) {
        reader.cancel().catch(() => {});
        return null;
    }

    const chunk = first.value;
    return new ReadableStream({
        start(c) {
            c.enqueue(chunk);
        },
        async pull(c) {
            const { done, value } = await reader.read();
            if (done) c.close();
            else c.enqueue(value);
        },
        cancel(reason) {
            reader.cancel(reason).catch(() => {});
        },
    });
}

export async function createStream(url, seekSeconds = 0, onDuration = null) {
    // The cookie-free path is ~3x faster (1.8s vs 7.4s) but only succeeds on
    // ~75% of unseen videos, so it is only safe now that a failure is detected
    // in seconds rather than surfacing as a 25s stall. Try fast, prove audio is
    // flowing, and fall back to the authenticated path when it isn't.
    const canTryFast = PROXY && Date.now() >= proxyDisabledUntil && COOKIES_ARGS.length > 0;
    if (canTryFast) {
        const started = performance.now();
        const fast = await _verifiedStream(url, seekSeconds, onDuration, { useCookies: false });
        if (fast) return fast;
        log.warn(`[stream] fast path gave no audio in ${Math.round(performance.now() - started)}ms — retrying with cookies`);
    }

    const resource = await _verifiedStream(url, seekSeconds, onDuration, { useCookies: true });
    if (resource) return resource;
    // Nothing produced audio. Throwing lets GuildQueue skip the track with a
    // real error instead of playing silence until the watchdog notices.
    throw new Error("stream produced no audio");
}

// The streaming extraction already parses the duration — `--print-to-file` drops
// it in a sidecar file (stdout stays pure audio) so the playing track needs no
// second yt-dlp at all. Poll the file rather than reading it once: the extractor
// writes it a second or two after spawn, well before the track has buffered.
const DURATION_POLL_MS = 400;
const DURATION_POLL_TRIES = 40;

// Returns a stop handle. The poller must not outlive the extraction that feeds
// it: a skipped track's file would otherwise be read seconds later and its
// duration written into a song that has already left the queue.
function _watchDurationFile(path, videoId, onDuration) {
    let tries = 0;
    let stopped = false;

    const timer = setInterval(() => void tick(), DURATION_POLL_MS);

    async function tick() {
        if (stopped) return;
        if (++tries > DURATION_POLL_TRIES) return stop();
        let raw;
        try {
            raw = (await Deno.readTextFile(path)).trim().split("\n");
        } catch {
            return; // not written yet
        }
        stop();
        const secs = Number(raw[0]);
        if (!Number.isFinite(secs) || secs <= 0) return;
        const duration = fmtSecs(secs);
        const cached = metaCache.get(videoId);
        if (cached) cached.duration = duration;
        onDuration(duration);
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        Deno.remove(path).catch(() => {});
    }

    // One last look when yt-dlp exits — it may have written the file between
    // ticks — then the poller is done either way.
    return { stop, settle: async () => { await tick(); stop(); } };
}

// Tear down a resource and reap its child procs. SIGTERM first so yt-dlp can
// propagate the signal to any ffmpeg child it spawned (--download-sections),
// then SIGKILL if it hasn't exited. Awaiting .status reaps the process and
// releases its stdio pipes — without this, killed procs leak as zombies.
export async function destroyResource(resource) {
    if (!resource) return;
    // Stop the duration poller before the procs die — a skipped track must not
    // keep reading a file to update a song that is no longer queued.
    try {
        resource._cleanup?.();
    } catch { /* nothing to stop */ }
    // Close the output stream so child stdout pipes receive EOF.
    try {
        resource.playStream?.destroy();
    } catch { /* already gone */ }

    await Promise.all((resource._procs ?? []).map((proc) => reap(proc)));
}

function _ytdlpStream(url, seekSeconds, onDuration = null, { useCookies = true } = {}) {
    const videoId = extractVideoId(url);
    let durationFile = null;
    if (onDuration && videoId) {
        // --print-to-file appends, so start from a clean file.
        durationFile = `/tmp/yt-duration-${videoId}.txt`;
        try {
            Deno.removeSync(durationFile);
        } catch { /* no leftover */ }
    }

    const args = [
        ...proxyArgs(),
        "--no-playlist", "-o", "-", "--quiet", "--no-warnings", "--no-check-formats",
        // Transient googlevideo 403s: retry the download and re-run the
        // extractor (fresh media URL) before giving up on the track.
        "--retries", "5", "--fragment-retries", "5", "--extractor-retries", "3",
        // Fail a dead/stalled connection fast instead of hanging the stream.
        "--socket-timeout", "15",
        ...(useCookies ? COOKIES_ARGS : []), ...CACHE_ARGS, ...POT_ARGS, ...EJS_ARGS, ...CLIENT_ARGS,
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

    if (durationFile) args.push("--print-to-file", "%(duration)s", durationFile);

    args.push(url);

    const usedProxy = args.includes("--proxy");
    const ytdlp = track(new Deno.Command(YTDLP, { args, stdout: "piped", stderr: "piped" }).spawn());
    // Let a queued duration backfill know a streaming extraction just started,
    // so it doesn't compete with it for CPU while the user waits for audio.
    _lastStreamSpawn = Date.now();

    let durationWatch = null;
    if (durationFile) {
        durationWatch = _watchDurationFile(durationFile, videoId, onDuration);
        // Bound the poller by the extraction itself, not just by its own tries.
        ytdlp.status.then(() => durationWatch.settle()).catch(() => durationWatch.stop());
    }
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
        // This stream is already lost (the watchdog will skip it), but the next
        // track can avoid the same fate.
        if (usedProxy) markProxyBad(`stream exited ${status.code}`);
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
        track(ffmpeg);
        ytdlp.stdout.pipeTo(ffmpeg.stdin).catch(() => {});
        return {
            out: ffmpeg.stdout,
            inputType: StreamType.Arbitrary,
            procs: [ytdlp, ffmpeg],
            lead: ffmpeg,
            cleanup: () => durationWatch?.stop(),
        };
    }

    return {
        out: ytdlp.stdout,
        inputType: StreamType.WebmOpus,
        procs: [ytdlp],
        lead: ytdlp,
        cleanup: () => durationWatch?.stop(),
    };
}

// Spawn, then prove audio is flowing before building the resource. Returns
// null when the extraction produced nothing, so the caller can try another way.
async function _verifiedStream(url, seekSeconds, onDuration, opts) {
    const spawned = _ytdlpStream(url, seekSeconds, onDuration, opts);
    const verified = await _awaitFirstByte(spawned.out, spawned.lead);
    if (!verified) {
        spawned.cleanup();
        await Promise.all(spawned.procs.map((p) => reap(p)));
        return null;
    }
    const resource = createAudioResource(Readable.fromWeb(verified), { inputType: spawned.inputType });
    resource._procs = spawned.procs;
    resource._cleanup = spawned.cleanup;
    return resource;
}
