// End-to-end check of the real streaming path: actual yt-dlp, actual YouTube,
// actual googlevideo. The unit tests stub Deno.Command, so they prove the logic
// but never that YouTube actually serves a playable stream — that only holds on
// a host with working cookies and a PO token, so this runs in the deployed
// container rather than in CI:
//
//   docker cp tests/e2e/streamCache.e2e.js music-bot.web.1:/tmp/e2e.js
//   dokku enter music-bot web deno run --allow-all /tmp/e2e.js
//
// Exits non-zero on failure so it can gate a release.
import { createStream, destroyResource } from "../../src/services/music/stream.js";

const VIDEO = Deno.args[0] ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
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

console.log(`\n== 1. cold play — ${VIDEO}`);
const cold = await timed("createStream", () => createStream(VIDEO, 0, () => {}));
ok(!!cold.out, "cold createStream returned a resource");
ok((cold.out?._procs?.length ?? 0) > 0, "cold play spawned yt-dlp (expected)");

const coldBytes = await readSome(cold.out);
console.log(`  first ${coldBytes.got} bytes in ${coldBytes.ms}ms`);
ok(coldBytes.got >= WANT_BYTES, `cold stream produced ${WANT_BYTES}+ bytes of audio`);

await destroyResource(cold.out);

console.log(`\n== 2. full-length playback (no truncation)`);
// A googlevideo URL fetched without ranges gets truncated by the server, which
// is how the format-URL cache silently cut a 4:19 track down to seconds. yt-dlp
// ranges its own downloads, so this reads well past that cliff.
const LONG_WANT = 1_500_000;
const long = await timed("createStream", () => createStream(VIDEO, 0, () => {}));
const longBytes = await readSome(long.out, LONG_WANT);
console.log(`  pulled ${longBytes.got} bytes in ${longBytes.ms}ms`);
ok(longBytes.got >= LONG_WANT, `stream delivered ${LONG_WANT}+ bytes without truncating`);
await destroyResource(long.out);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
Deno.exit(failures === 0 ? 0 : 1);
