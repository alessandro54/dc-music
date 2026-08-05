// End-to-end check of the real streaming path: actual yt-dlp, actual YouTube,
// actual googlevideo. The unit tests stub Deno.Command and fetch, so they can
// prove the logic but never that a cached URL is one YouTube will serve — that
// assumption is only true on a host with working cookies + PO token, which is
// why this runs in the deployed container rather than in CI:
//
//   docker cp tests/e2e/streamCache.e2e.js music-bot.web.1:/tmp/e2e.js
//   dokku enter music-bot web deno run --allow-all /tmp/e2e.js
//
// Exits non-zero on failure so it can gate a release.
import {
    _formatUrlCacheForTests,
    createStream,
    destroyResource,
    prefetchFormatUrl,
} from "../../src/services/music/stream.js";

const VIDEO = Deno.args[0] ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SECOND_VIDEO = Deno.args[1] ?? "https://www.youtube.com/watch?v=kJQP7kOUFYk";
const WANT_BYTES = 65536;

let failures = 0;
const ok = (cond, msg) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
    if (!cond) failures++;
};

// Pull real audio bytes off the resource — the only proof the stream is alive.
async function readSome(resource, want = WANT_BYTES) {
    let got = 0;
    const started = performance.now();
    try {
        for await (const chunk of resource.playStream) {
            got += chunk.length;
            if (got >= want) break;
        }
    } catch (err) {
        console.log(`  (stream error after ${got} bytes: ${err.message})`);
    }
    return { got, ms: Math.round(performance.now() - started) };
}

async function timed(label, fn) {
    const t = performance.now();
    const out = await fn();
    const ms = Math.round(performance.now() - t);
    console.log(`  ${label}: ${ms}ms`);
    return { out, ms };
}

console.log(`\n== 1. cold play (no cache) — ${VIDEO}`);
const cache = _formatUrlCacheForTests();
cache.clear();

const cold = await timed("createStream", () => createStream(VIDEO, 0, () => {}));
ok(!!cold.out, "cold createStream returned a resource");
ok((cold.out?._procs?.length ?? 0) > 0, "cold play spawned yt-dlp (expected)");

const coldBytes = await readSome(cold.out);
console.log(`  first ${coldBytes.got} bytes in ${coldBytes.ms}ms`);
ok(coldBytes.got >= WANT_BYTES, `cold stream produced ${WANT_BYTES}+ bytes of audio`);

// The URL lands in the sidecar mid-extraction; the poller ticks every 400ms.
console.log("  waiting for the sidecar to surface the media URL…");
for (let i = 0; i < 30 && cache.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 400));
}
ok(cache.size > 0, "media URL was captured into the cache during playback");
await destroyResource(cold.out);

console.log(`\n== 2. warm play (cached URL, no subprocess)`);
if (cache.size === 0) {
    console.log("  SKIP — nothing cached, cannot test the warm path");
    failures++;
} else {
    const warm = await timed("createStream", () => createStream(VIDEO, 0, () => {}));
    ok(!!warm.out, "warm createStream returned a resource");
    ok((warm.out?._procs?.length ?? 0) === 0, "warm play spawned NO yt-dlp");

    const warmBytes = await readSome(warm.out);
    console.log(`  first ${warmBytes.got} bytes in ${warmBytes.ms}ms`);
    ok(warmBytes.got >= WANT_BYTES, "cached URL actually served audio (not a 403)");
    ok(
        warm.ms + warmBytes.ms < cold.ms + coldBytes.ms,
        `warm path beat cold (${warm.ms + warmBytes.ms}ms vs ${cold.ms + coldBytes.ms}ms)`,
    );
    await destroyResource(warm.out);
}

console.log(`\n== 3. prefetch — ${SECOND_VIDEO}`);
const before = cache.size;
const pre = await timed("prefetchFormatUrl", () => prefetchFormatUrl(SECOND_VIDEO));
ok(pre.out === true, "prefetch reported success");
ok(cache.size === before + 1, "prefetch added an entry to the cache");

const pf = await timed("createStream after prefetch", () => createStream(SECOND_VIDEO, 0, () => {}));
ok((pf.out?._procs?.length ?? 0) === 0, "prefetched track played with NO yt-dlp");
const pfBytes = await readSome(pf.out);
console.log(`  first ${pfBytes.got} bytes in ${pfBytes.ms}ms`);
ok(pfBytes.got >= WANT_BYTES, "prefetched URL actually served audio");
await destroyResource(pf.out);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
Deno.exit(failures === 0 ? 0 : 1);
