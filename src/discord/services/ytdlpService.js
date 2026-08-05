import { log } from "@/lib/logger.js";

// Everything about *running* yt-dlp: the argument sets, the proxy/cookie policy,
// and the child-process registry. Nothing here knows what a song or a queue is —
// metadataService and streamService decide what to ask for, this decides how the
// process gets spawned, retried and reaped.

const YTDLP = Deno.env.get("YTDLP_PATH") || `${import.meta.dirname}/yt-dlp`;

export const dec = new TextDecoder();

export const AUDIO_FMT = "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=opus]/bestaudio";

// ── cookies ────────────────────────────────────────────────────────────────
let COOKIES_ARGS = [];
function writeCookies(text) {
    Deno.writeTextFileSync("/tmp/yt-cookies.txt", text);
    COOKIES_ARGS = ["--cookies", "/tmp/yt-cookies.txt"];
}

const cookies = Deno.env.get("YOUTUBE_COOKIES");
if (cookies) {
    try {
        writeCookies(cookies);
        log.info("[ytdlp] YouTube cookies loaded");
    } catch (err) {
        log.error(`[ytdlp] Failed to write cookies: ${err.message}`);
    }
}

// Hot-swap cookies at runtime (see commands/admin/setcookies.js). Takes effect on
// the next yt-dlp call — no restart needed — but doesn't persist: the host's
// YOUTUBE_COOKIES config var still wins on the next deploy/restart.
export function reloadCookies(text) {
    writeCookies(text);
    log.info("[ytdlp] YouTube cookies reloaded (live only — update YOUTUBE_COOKIES on the host to persist)");
}

export const hasCookies = () => COOKIES_ARGS.length > 0;

// ── argument sets ──────────────────────────────────────────────────────────
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
    log.info(`[ytdlp] PO-token provider → ${potBaseUrl}`);
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

// Metadata needs a title and a duration — not a playable format URL. Pinning a
// single lightweight client and skipping the player JS avoids yt-dlp probing
// clients one by one, and --ignore-no-formats-error keeps it from bailing when
// that client serves no usable format. Measured on the prod IP: 1.4-1.8s vs
// 3.8s for the full streaming arg set, same title and duration.
export const META_ARGS = [
    "--ignore-no-formats-error",
    "--extractor-args",
    "youtube:player_client=ios;player_skip=js",
];

// The full extraction set — what playback itself can see. Used as the metadata
// retry for private/unlisted videos the cheap client can't reach.
export const FULL_EXTRACT_ARGS = () => [...POT_ARGS, ...EJS_ARGS, ...CLIENT_ARGS];

export const cacheArgs = () => CACHE_ARGS;
export const potArgs = () => POT_ARGS;
export const ejsArgs = () => EJS_ARGS;

// ── proxy policy ───────────────────────────────────────────────────────────
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

export const proxyHealthy = () => Boolean(PROXY) && Date.now() >= proxyDisabledUntil;

export function proxyArgs() {
    return proxyHealthy() ? ["--proxy", PROXY] : [];
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
export function cookieArgs({ critical = false } = {}) {
    if (!critical && proxyHealthy()) return [];
    return COOKIES_ARGS;
}

export function markProxyBad(reason) {
    if (!PROXY || Date.now() < proxyDisabledUntil) return;
    proxyDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
    log.warn(`[ytdlp] proxy failed (${reason}) — going direct for ${PROXY_COOLDOWN_MS / 60000}min`);
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

if (PROXY) log.info(`[ytdlp] yt-dlp proxy → ${PROXY}`);

// ── child process lifecycle ────────────────────────────────────────────────
// Every yt-dlp/ffmpeg the bot spawns is registered here. docker-init at PID 1
// does reap orphans (despite tini's warning at boot), but only once they exit —
// a proc that hangs instead of exiting is nobody's problem but ours, and it sits
// there for the container's whole uptime.
const liveProcs = new Set();

// Cancels in-flight waits (backfill delays) at shutdown so nothing spawns on
// the way out.
let _shutdownAC = new AbortController();

export const shutdownSignal = () => _shutdownAC.signal;

export function track(proc) {
    liveProcs.add(proc);
    proc.status.finally(() => liveProcs.delete(proc)).catch(() => liveProcs.delete(proc));
    return proc;
}

// SIGTERM, then SIGKILL if it's still there. Awaiting .status is what actually
// reaps the child and releases its stdio pipes.
export async function reap(proc, graceMs = 2000) {
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

export const sleep = (ms, signal) =>
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

// Kill everything the bot owns. Called from the shutdown path so a redeploy
// doesn't leave yt-dlp children behind.
export async function shutdownStreams() {
    _shutdownAC.abort();
    const procs = [...liveProcs];
    liveProcs.clear();
    if (procs.length) log.info(`[ytdlp] reaping ${procs.length} child process(es)`);
    await Promise.all(procs.map((p) => reap(p, 1000)));
}

// Tests re-arm the module between cases; production never calls this.
export function _resetForTests() {
    _shutdownAC = new AbortController();
    liveProcs.clear();
    // The proxy cooldown is module state; without clearing it one test that
    // trips a fallback silently changes the path every later test takes.
    proxyDisabledUntil = 0;
}

// ── spawning ───────────────────────────────────────────────────────────────

// Spawn a tracked yt-dlp with the given args (already assembled by the caller).
export function spawn(args) {
    return track(new Deno.Command(YTDLP, { args, stdout: "piped", stderr: "piped" }).spawn());
}

// Run a one-shot yt-dlp (metadata / playlist dump) under a hard deadline.
// Deno.Command#output() can't be aborted, so the proc is spawned and raced —
// on timeout it gets killed and reaped rather than left running with a pipe
// nobody reads.
export async function runYtdlp(args, { timeoutMs, what }) {
    const viaProxy = proxyArgs();
    const res = await _runOnce([...viaProxy, ...args], { timeoutMs, what });
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
        return _runOnce(withCookies, { timeoutMs, what });
    }
    return res;
}

async function _runOnce(args, { timeoutMs, what }) {
    const proc = spawn(args);
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
