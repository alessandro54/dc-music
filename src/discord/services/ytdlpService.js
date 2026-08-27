import { TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";
import { captureError } from "@/lib/sentry.js";

// Everything about *running* yt-dlp: the argument sets, the proxy/cookie policy,
// and the child-process registry. Nothing here knows what a song or a queue is —
// metadataService and streamService decide what to ask for, this decides how the
// process gets spawned, retried and reaped.

const YTDLP = Deno.env.get("YTDLP_PATH") || `${import.meta.dirname}/yt-dlp`;

export const dec = new TextDecoder();

export const AUDIO_FMT = "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=opus]/bestaudio";

// ── cookies ────────────────────────────────────────────────────────────────
// yt-dlp rewrites the jar on every exit, because YouTube rotates session tokens
// as they are used — that refresh is how a session stays alive. Keeping the jar
// in /tmp threw it away on every deploy and re-seeded from the config var, i.e.
// replayed a stale snapshot, which is what makes YouTube invalidate a session.
// So it goes on the one path that survives a release: /data/ytdlp-cache is the
// Dokku bind mount (`/data` itself is container-local — its mtime is the
// container's start time).
const PERSIST_DIR = "/data/ytdlp-cache";

function pickCookieDir() {
    try {
        Deno.mkdirSync(PERSIST_DIR, { recursive: true });
        const probe = `${PERSIST_DIR}/.write-test`;
        Deno.writeTextFileSync(probe, "");
        Deno.removeSync(probe);
        return PERSIST_DIR;
    } catch {
        // No mount (local dev, or the volume is gone). /tmp still keeps rotation
        // for the life of the container, it just loses it on the next release.
        return "/tmp";
    }
}

const COOKIE_DIR = pickCookieDir();
const COOKIE_FILE = `${COOKIE_DIR}/yt-cookies.txt`;

let COOKIES_ARGS = [];
function writeCookies(text) {
    Deno.writeTextFileSync(COOKIE_FILE, text);
    COOKIES_ARGS = ["--cookies", COOKIE_FILE];
}

// Cheap non-crypto digest (djb2). It only has to answer "is the config var still
// the one this jar was seeded from?", and it runs at module scope, where the
// async WebCrypto API would not.
function digest(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return `${(h >>> 0).toString(16)}:${text.length}`;
}

const readIfExists = (path) => {
    try {
        return Deno.readTextFileSync(path);
    } catch {
        return null;
    }
};

// What the jar should start as. `YOUTUBE_COOKIES` is a *seed*, not the authority:
// once yt-dlp has rotated the jar, the file on disk is newer than the var, and
// rewriting it would undo the refresh. So the var only wins when it has actually
// changed — which is exactly when the operator has re-exported.
function _seedCookies(envCookies, dir = COOKIE_DIR) {
    const file = `${dir}/yt-cookies.txt`;
    const seedFile = `${dir}/.cookie-seed`;
    const persisted = readIfExists(file);

    if (!envCookies) {
        // A jar with no var behind it is still a jar — /setcookies uploads live
        // here too, and a volume that has one should keep working.
        return {
            reason: persisted ? "persisted jar, no config var set" : null,
            file,
            hasCookies: !!persisted,
        };
    }

    const seed = digest(envCookies);
    if (persisted && readIfExists(seedFile) === seed) {
        return { reason: "persisted jar (config var unchanged)", file, hasCookies: true };
    }

    Deno.writeTextFileSync(file, envCookies);
    try {
        Deno.writeTextFileSync(seedFile, seed);
    } catch { /* unwritable dir: the var simply reseeds on every boot */ }
    return {
        reason: persisted ? "config var changed — reseeded" : "seeded from config var",
        file,
        hasCookies: true,
    };
}

export const _seedCookiesForTests = _seedCookies;

const seeded = _seedCookies(Deno.env.get("YOUTUBE_COOKIES"));
if (seeded.hasCookies) {
    COOKIES_ARGS = ["--cookies", seeded.file];
    log.info(`[ytdlp] YouTube cookies loaded — ${seeded.reason} (${seeded.file})`);
}

// Hot-swap cookies at runtime (see commands/admin/setcookies.js). Takes effect on
// the next yt-dlp call, no restart needed. The seed marker is deliberately *not*
// updated: it still records the config var, so the next boot sees an unchanged
// var and keeps this upload instead of reverting to the var's older value.
export function reloadCookies(text) {
    writeCookies(text);
    log.info(
        `[ytdlp] YouTube cookies reloaded — ${
            COOKIE_DIR === PERSIST_DIR
                ? "persisted, survives restarts (set YOUTUBE_COOKIES too, for a fresh volume)"
                : "live only, no persistent volume here"
        }`,
    );
}

export const hasCookies = () => COOKIES_ARGS.length > 0;

// YouTube answers a dead cookie jar with the *same* "Sign in to confirm you're
// not a bot" it gives an unauthenticated flagged IP, so an expired session is
// indistinguishable from extractor breakage in the logs. Matching it in one
// place is what lets the proxy policy and the error reporting tell the two
// apart — see `markProxyBad`'s callers and `checkCookieSession` below.
//
// All of these mean "YouTube refused the credentials", never "the transport
// failed", which is the distinction every caller here actually needs.
const LOGIN_GATE_RE = /Sign in to confirm|LOGIN_REQUIRED|not a bot|Login details are needed/i;
export const isLoginGate = (text) => LOGIN_GATE_RE.test(text ?? "");

// yt-dlp's own verdict on a rotated session, and the only message that says so
// outright. It arrives as a *warning* with exit 0 on the first call of a fresh
// process — measured: run 1 exited 0 with this warning, runs 2 and 3 exited 1
// with "Login details are needed" — so an exit-code-only check reports live
// cookies once per boot, which is exactly when this runs.
const COOKIES_ROTATED_RE = /cookies are no longer valid|cookies have been rotated/i;

// Is the cookie jar still an authenticated session? Ask yt-dlp for the
// account's own watch history: `:ythistory` is auth-only, so its answer is about
// the cookies and nothing else. A video probe cannot say that — its failure
// could be the video, the IP or the session, and that ambiguity is exactly what
// let a dead jar read as extractor breakage.
//
// Two cheaper checks were measured and rejected. The youtube.com ytcfg blob:
// Deno's fetch is served a 37KB bot shell with no ytcfg in it at all (curl gets
// 869KB), so the marker is simply absent. And youtubei.js `session.logged_in`:
// it returns true for a junk cookie string, so it reports that a cookie was
// supplied, not that YouTube accepted it.
//
// Runs direct and with cookies, matching the streaming path this predicts.
const HISTORY_PROBE_ARGS = [
    "--flat-playlist",
    "--simulate",
    "--playlist-items",
    "1",
    "--print",
    "%(id)s",
    ":ythistory",
];

// `ok: null` means the probe itself was inconclusive — a timeout, or a failure
// whose message is not the login one. Deliberately not reported as expired:
// crying wolf about live cookies sends someone re-exporting for nothing, and the
// signal is only worth having because it is unambiguous.
export async function checkCookieSession({ timeoutMs = 20_000 } = {}) {
    if (!hasCookies()) return { ok: false, reason: "no cookies configured" };
    let res;
    try {
        res = await _runOnce([...CACHE_ARGS, ...COOKIES_ARGS, ...HISTORY_PROBE_ARGS], {
            timeoutMs,
            what: "cookie check",
        });
    } catch (err) {
        return { ok: null, reason: err.message };
    }
    const stderr = dec.decode(res.stderr).trim();
    // Read stderr before the exit code, deliberately: a rotated session is a
    // warning-with-exit-0 the first time, so a code-first check would call it
    // authenticated.
    if (COOKIES_ROTATED_RE.test(stderr)) return { ok: false, reason: "cookies rotated in the browser" };
    if (isLoginGate(stderr)) return { ok: false, reason: "session expired" };
    // Nothing printed does *not* mean unauthenticated: a throwaway account has
    // an empty watch history, which is the normal case here (measured: exit 0,
    // no stdout, no warnings on a good jar). A clean exit with neither complaint
    // above is the pass — the rotated jar is caught by its warning, not by the
    // absence of items.
    if (res.code === 0) return { ok: true, reason: "authenticated" };
    return { ok: null, reason: stderr.split("\n").pop()?.slice(0, 200) || `exited ${res.code}, no output` };
}

// Dead-but-present cookies are the worst case: `hasCookies()` is true, so every
// play skips nothing and pays the ~7.4s authenticated path before failing on
// exactly the gated videos the cookies were there for. Say so once, plainly,
// instead of leaving it to look like yt-dlp broke.
export async function logCookieHealth(opts) {
    const { ok, reason } = await checkCookieSession(opts);
    // Prime the watcher: without this a jar already dead at boot files a fresh
    // issue at the first tick, having already said so in the boot log.
    if (ok !== null) lastCookieState = ok;
    if (ok === true) log.info("[ytdlp] YouTube cookie session live");
    else if (ok === false) {
        log.warn(
            `[ytdlp] YouTube cookies are NOT authenticated (${reason}) — gated videos will fail ` +
                'with "Sign in to confirm". Re-export and run /setcookies.',
        );
    } else log.warn(`[ytdlp] cookie check inconclusive (${reason}) — assuming they are fine`);
    return ok;
}

// The boot check alone misses the case that actually happened: the session was
// rotated 20 hours into an uptime, so nothing noticed until the next restart.
// Re-check on an interval and report the *transition*, not every tick — a jar
// that has been dead for a day should not file an issue every 6h.
let cookieWatch = null;
let lastCookieState;

export function startCookieWatch({ everyMs = TIMEOUTS.COOKIE_CHECK_MS } = {}) {
    if (cookieWatch || !hasCookies()) return;
    cookieWatch = setInterval(async () => {
        const { ok, reason } = await checkCookieSession();
        // Inconclusive says nothing about the session — leave the last known
        // state alone rather than treating it as a change in either direction.
        if (ok === null) return;
        if (ok === lastCookieState) return;
        lastCookieState = ok;
        if (ok) return void log.info("[ytdlp] YouTube cookie session is live again");
        log.warn(`[ytdlp] YouTube cookie session went dead (${reason}) — re-export and run /setcookies`);
        captureError(new Error(`YouTube cookie session went dead: ${reason}`), {
            tags: { stage: "cookies" },
        });
    }, everyMs);
}

export function stopCookieWatch() {
    clearInterval(cookieWatch);
    cookieWatch = null;
}

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

// Force PO-token fetching, and pin the one client that still serves playable
// audio on this IP.
// - player_client=web_embedded: letting yt-dlp pick used to work, and stopped
//   on 2026-08-18. Measured that day on prod, cookied, through WARP: the whole
//   default set fails — `tv_downgraded` answers UNPLAYABLE / "The page needs to
//   be reloaded.", and `web` comes back with formats that have no URL because
//   YouTube forces SABR on it (https://github.com/yt-dlp/yt-dlp/issues/12482).
//   Of every client tried, only `web_embedded` yields bytes: `tv`/`tv_simply`/
//   `web_safari`/`android_vr`/`ios` serve no usable format, and `mweb` hands
//   back a URL that then 403s on download — which is the failure a `-g` check
//   cannot see, so verify a pin by pulling real bytes, not by printing the URL.
//   Confirmed on 4 videos, cookied *and* cookie-free, so the fast path keeps
//   working. `default` stays as the tail of the list: it costs nothing while it
//   is broken, and takes over by itself if YouTube reverts.
// - fetch_pot=always: some clients skip the PO token by default, but some
//   videos' GVS URLs require one → 403. Forcing it makes bgutil always mint
//   the player + gvs tokens.
//
// The pin is overridable at runtime because this has now broken twice from
// YouTube-side changes, and a code push means a fresh image build plus a deploy.
// `dokku config:set music-bot YTDLP_PLAYER_CLIENTS=…` + restart is the 30-second
// version of the same fix. Comma-separated, yt-dlp's own syntax.
const PRIMARY_CLIENTS = Deno.env.get("YTDLP_PLAYER_CLIENTS") || "web_music";

// Tried only after the primary list has produced no audio at all — see
// `createStream`'s escalation. web_embedded leads: it is the proven audio
// server on this IP (it was the primary until web_music beat it by 4.3s) and it
// is also what covers web_music's known gap — videos "not available on YouTube
// Music" (gameplay, some old uploads; measured 2026-08-27). `mweb` is useless
// as a primary (it extracts, then 403s at download) but it *sees* videos
// web_embedded cannot, so it earns a place on a path whose alternative is
// dropping the track. tv_simply and android_vr were dropped after measurement:
// on this IP they return storyboards-only / no formats, and every listed client
// is a player API call the escalation pays for.
const FALLBACK_CLIENTS = "web_embedded,default,mweb,ios";

if (Deno.env.get("YTDLP_PLAYER_CLIENTS")) {
    log.info(`[ytdlp] player_client pinned by config → ${PRIMARY_CLIENTS}`);
}

// use_ad_playback_context sends adPlaybackContext:{pyv:true} with the player
// request, which suppresses the pre-roll ad placement in the response. Without
// it, yt-dlp *simulates watching the ad*: the format carries `available_at` and
// the downloader sleeps it off — the log line "Sleeping 4.00 seconds as
// required by the site", ~4s on every cold play from this account. Measured
// 2026-08-27, cookied, direct: web_music 8723ms with the sleep, 3454ms without.
// The flag is gated per-client by SUPPORTS_AD_PLAYBACK_CONTEXT in yt-dlp
// (web_music and mweb today), so it is inert for every other client in a list.
const clientArgs = (clients) => [
    "--extractor-args",
    `youtube:fetch_pot=always;player_client=${clients};use_ad_playback_context=true`,
];

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
// `clients` selects which pin to use: the primary list, or the fallback list a
// last-ditch attempt escalates to. Callers that don't care get the primary.
export const FULL_EXTRACT_ARGS = (clients = PRIMARY_CLIENTS) => [
    ...POT_ARGS,
    ...EJS_ARGS,
    ...clientArgs(clients),
];

export const PLAYER_CLIENTS = { primary: PRIMARY_CLIENTS, fallback: FALLBACK_CLIENTS };

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

// Is this stderr evidence that the *proxy hop* broke, rather than a verdict on
// the video? "Not a login gate" was standing in for this, and it is far too
// broad: a private, deleted or region-blocked video, an age gate, or a playlist
// item that has gone — all of them exit non-zero with nothing to do with the
// proxy, and all of them used to cost every play for the next 5min the slow
// authenticated route. Transport failures name themselves, so match those.
const PROXY_FAULT_RE =
    /unable to connect to proxy|cannot connect to proxy|tunnel connection failed|proxyerror|socks|connection reset|connection refused|connection aborted|remote end closed connection|read timed out|timed out/i;

export const isProxyFault = (text) => PROXY_FAULT_RE.test(text ?? "");

export function markProxyBad(reason) {
    if (!PROXY || Date.now() < proxyDisabledUntil) return;
    proxyDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
    log.warn(`[ytdlp] proxy failed (${reason}) — going direct for ${PROXY_COOLDOWN_MS / 60000}min`);
}

// The speculative fast attempt missing is NOT evidence that the proxy is bad —
// it is documented to miss on ~25% of unseen videos, and the caller retries with
// cookies on the spot. A single miss used to trip the cooldown, and because the
// cooldown disables the fast path itself, nothing then re-tested the proxy: one
// in four cold plays turned WARP off for 5 minutes at a stretch.
//
// A *broken* proxy still has to be noticed, though, or every play pays a doomed
// attempt forever. The distinguishing signal is consecutive misses: at 25% a run
// of three is ~1.6% of cold plays, while a dead hop misses every time and is out
// after three. Any hit resets the count.
const FAST_MISS_STRIKES = 3;
let fastMisses = 0;

export function noteFastPathHit() {
    fastMisses = 0;
}

export function noteFastPathMiss() {
    if (++fastMisses < FAST_MISS_STRIKES) return;
    markProxyBad(`fast path missed ${fastMisses}x in a row`);
    fastMisses = 0;
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
    stopCookieWatch();
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
    fastMisses = 0;
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
        // Same rule as the streaming path: only transport evidence blames the
        // proxy. `!isLoginGate` was the old test and it is backwards — the
        // comment above admits a non-zero exit here is *indistinguishable* from
        // an unavailable video, and then blamed the proxy for it anyway. One
        // private video in a playlist dump cost every play for the next 5min the
        // slow route. Retry direct regardless: that is cheap and the second
        // result is what the caller judges.
        if (isProxyFault(dec.decode(res.stderr))) markProxyBad(`${what} exited ${res.code}`);
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
