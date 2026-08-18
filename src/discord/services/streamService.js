import { createAudioResource, StreamType } from "@discordjs/voice";
import { Readable } from "node:stream";

import { cacheDuration, clearMetaCache, noteStreamSpawn } from "@/discord/services/metadataService.js";
import {
    _resetForTests as _resetYtdlpForTests,
    AUDIO_FMT,
    cacheArgs,
    cookieArgs,
    dec,
    FULL_EXTRACT_ARGS,
    hasCookies,
    isLoginGate,
    markProxyBad,
    proxyArgs,
    proxyHealthy,
    reap,
    spawn,
    track,
} from "@/discord/services/ytdlpService.js";
import { log } from "@/lib/logger.js";
import { extractVideoId, fmtSecs, isYouTubeUrl, trackKey } from "@/lib/media.js";
import { captureError } from "@/lib/sentry.js";

// Audio only: turn a URL into a playable AudioResource, and tear one down.
// Process spawning/args live in ytdlpService; titles and durations in
// metadataService.

// A googlevideo media URL cannot be fetched with a plain GET: the server
// truncates an un-ranged request. Measured on a 4:19 track its clen said
// 4,429,008 bytes while a single fetch returned 622,592, so playback ended a
// few seconds in. yt-dlp downloads in ranged chunks, which is why it is
// correct. A format-URL cache therefore needs a ranged reader, not a fetch —
// until it has one there is no cache, and the cookie-free fast path already
// gets a cold play to ~2s on its own.

// Tests re-arm the modules between cases; production never calls this.
export function _resetShutdownForTests() {
    _resetYtdlpForTests();
    clearMetaCache();
}

// Wait for the stream to actually produce a byte, so a dead extraction is
// caught here instead of surfacing 25s later as a stalled track. Returns a
// stream with that first chunk put back, or null when nothing ever arrived.
//
// The two attempts get different budgets because they mean different things. The
// fast attempt is speculative — a miss is expected and costs only the retry, so
// it stays cheap. The authenticated attempt is the last chance: giving up on it
// means the track is dropped, so it gets room to finish.
//
// 9s for both was too tight for the cookie path and silently so. Measured to
// first audio on this host, cold: 7757ms / 9089ms through WARP, 8010ms / 7923ms
// direct — a coin flip against a 9s ceiling, and the proxy is not the variable.
// It went unnoticed because a login gate on the fast attempt used to trip the
// proxy cooldown, which shaved off the hop that pushed it over.
const FIRST_BYTE_FAST_MS = 9000;
// Stays clear of STREAM_STALL_MS (25s), which is the watchdog behind this one.
const FIRST_BYTE_COOKIE_MS = 20_000;

export async function _awaitFirstByte(webStream, proc, timeoutMs = FIRST_BYTE_FAST_MS) {
    const reader = webStream.getReader();
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
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

// `transcode` is declared by the resolver that produced the song (SoundCloud sets
// it), so adding a source doesn't mean editing this file. The URL sniff is only a
// safety net: a source that forgets the flag would otherwise play silence, which
// is the worst possible failure mode.
export async function createStream(url, seekSeconds = 0, onDuration = null, { transcode } = {}) {
    const opts = { transcode: transcode ?? !isYouTubeUrl(url) };

    // The cookie-free path is ~3x faster (1.8s vs 7.4s) but only succeeds on
    // ~75% of unseen videos, so it is only safe now that a failure is detected
    // in seconds rather than surfacing as a 25s stall. Try fast, prove audio is
    // flowing, and fall back to the authenticated path when it isn't.
    // The fast/slow cookie dance exists to get past YouTube's login gate on this
    // IP. Other sources aren't gated, so they get one direct attempt.
    const canTryFast = isYouTubeUrl(url) && proxyHealthy() && hasCookies();
    if (canTryFast) {
        const started = performance.now();
        const fast = await _verifiedStream(url, seekSeconds, onDuration, { ...opts, useCookies: false });
        if (fast) return fast;
        log.warn(
            `[stream] fast path gave no audio in ${
                Math.round(performance.now() - started)
            }ms — retrying with cookies`,
        );
    }

    const resource = await _verifiedStream(url, seekSeconds, onDuration, { ...opts, useCookies: true });
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
        cacheDuration(videoId, duration);
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
    return {
        stop,
        settle: async () => {
            await tick();
            stop();
        },
    };
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

function _ytdlpStream(url, seekSeconds, onDuration = null, { useCookies = true, transcode = false } = {}) {
    const videoId = extractVideoId(url);
    let durationFile = null;
    if (onDuration) {
        // --print-to-file appends, so start from a clean file.
        durationFile = `/tmp/yt-duration-${trackKey(url)}.txt`;
        try {
            Deno.removeSync(durationFile);
        } catch { /* no leftover */ }
    }

    const args = [
        ...proxyArgs(),
        "--no-playlist",
        "-o",
        "-",
        "--quiet",
        "--no-warnings",
        "--no-check-formats",
        // Transient googlevideo 403s: retry the download and re-run the
        // extractor (fresh media URL) before giving up on the track.
        "--retries",
        "5",
        "--fragment-retries",
        "5",
        "--extractor-retries",
        "3",
        // Fail a dead/stalled connection fast instead of hanging the stream.
        "--socket-timeout",
        "15",
        // A stream failure is heard by the listener, so it always gets cookies.
        ...(useCookies ? cookieArgs({ critical: true }) : []),
        ...cacheArgs(),
        ...FULL_EXTRACT_ARGS(),
    ];

    if (seekSeconds > 0) {
        args.push(
            "-f",
            "bestaudio/best",
            "--download-sections",
            `*${seekSeconds}-inf`,
            "--force-keyframes-at-cuts",
        );
    } else {
        args.push("-f", AUDIO_FMT);
    }

    if (durationFile) args.push("--print-to-file", "%(duration)s", durationFile);

    args.push(url);

    const usedProxy = args.includes("--proxy");
    const ytdlp = spawn(args);
    // Let a queued duration backfill know a streaming extraction just started,
    // so it doesn't compete with it for CPU while the user waits for audio.
    noteStreamSpawn();

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
    const tail = [];
    (async () => {
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
        //
        // A login gate is not a proxy fault, and blaming the proxy for one is
        // actively harmful: it disables the fast path for 5min, so every play in
        // that window pays the ~7.4s authenticated route — and if the cookies
        // are what's gated, the fallback it forced cannot work either. Observed
        // on prod: one gated video knocked WARP out while WARP was healthy.
        const stderr = tail.join("\n");
        if (usedProxy && !isLoginGate(stderr)) markProxyBad(`stream exited ${status.code}`);
        // The cookie-free attempt is *expected* to fail on ~25% of unseen videos
        // — that miss is the whole reason the cookie path exists, and the caller
        // retries immediately. Reporting it made one failed play emit two Sentry
        // issues, with no way to tell a recovered miss from a dead track. Only
        // the authenticated attempt, which has no fallback behind it, is news.
        if (!useCookies) {
            log.warn(`[stream] fast path exited ${status.code}: ${tail[tail.length - 1] ?? "no stderr"}`);
            return;
        }
        captureError(new Error(`yt-dlp exited ${status.code}: ${tail[tail.length - 1] ?? "no stderr"}`), {
            tags: {
                stage: "ytdlp",
                exitCode: String(status.code),
                useCookies: "true",
                // Separates "the session is dead" from every other extraction
                // failure at the Sentry level, since the message is the same.
                loginGate: String(isLoginGate(stderr)),
            },
            extra: { url, seekSeconds, stderr },
        });
    })();

    // ffmpeg is needed for two reasons: seeking (yt-dlp hands us a mid-stream
    // slice that isn't a valid container on its own) and any source that doesn't
    // serve webm/opus. Same pipeline either way — opus at 48kHz stereo.
    if (seekSeconds > 0 || transcode) {
        const ffmpeg = new Deno.Command("ffmpeg", {
            args: [
                "-threads",
                "1",
                "-i",
                "pipe:0",
                "-vn",
                "-acodec",
                "libopus",
                "-b:a",
                "96k",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-f",
                "opus",
                "pipe:1",
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
            stderrTail: tail,
            cleanup: () => durationWatch?.stop(),
        };
    }

    return {
        out: ytdlp.stdout,
        inputType: StreamType.WebmOpus,
        procs: [ytdlp],
        lead: ytdlp,
        stderrTail: tail,
        cleanup: () => durationWatch?.stop(),
    };
}

// Spawn, then prove audio is flowing before building the resource. Returns
// null when the extraction produced nothing, so the caller can try another way.
async function _verifiedStream(url, seekSeconds, onDuration, opts) {
    const spawned = _ytdlpStream(url, seekSeconds, onDuration, opts);
    const budget = opts.useCookies ? FIRST_BYTE_COOKIE_MS : FIRST_BYTE_FAST_MS;
    const verified = await _awaitFirstByte(spawned.out, spawned.lead, budget);
    if (!verified) {
        spawned.cleanup();
        await Promise.all(spawned.procs.map((p) => reap(p)));
        // The authenticated attempt is the last one, so its failure is what the
        // listener hears. It is also the one the stderr watcher above can't
        // report: giving up on first byte means *we* kill the extractor, and a
        // signalled exit is indistinguishable there from a skip. Reporting it
        // here is what makes a hung cookie path visible at all — previously it
        // reached Sentry only as a bare "stream produced no audio".
        if (opts.useCookies) {
            const stderr = spawned.stderrTail.join("\n");
            captureError(new Error("cookie path produced no audio"), {
                tags: { stage: "stream", useCookies: "true", loginGate: String(isLoginGate(stderr)) },
                extra: {
                    url,
                    seekSeconds,
                    timeoutMs: budget,
                    stderr: stderr || "no stderr",
                },
            });
        }
        return null;
    }
    const resource = createAudioResource(Readable.fromWeb(verified), { inputType: spawned.inputType });
    resource._procs = spawned.procs;
    resource._cleanup = spawned.cleanup;
    return resource;
}
