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
        // Same exemption as the streaming path: a login gate says nothing about
        // the proxy, and blaming it costs every later call the slow route for
        // 5min. Still retry direct — the cookies are what the gate is asking for.
        if (!isLoginGate(dec.decode(res.stderr))) markProxyBad(`${what} exited ${res.code}`);
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
