// Process-level setup, as a side-effect module so it runs *before* any service
// module is evaluated. That ordering is load-bearing twice over:
//
//   - `@/lib/sentry.js` runs `Sentry.init` on evaluation, and the handlers below
//     are the last resort for anything the app throws outside a handler.
//   - `ytdlpService.js` reads `YTDLP_PATH` once, at module scope. Setting it from
//     a function called after the imports would be too late — the service would
//     already have snapshotted the fallback path.
//
// So `src/index.js` imports this first, and the import sorter leaves side-effect
// imports where they are.
import { COMMIT } from "@/lib/buildInfo.js";
import { log } from "@/lib/logger.js";
import { captureError } from "@/lib/sentry.js";

process.on("unhandledRejection", (err) => {
    log.error(`unhandledRejection: ${err}`);
    captureError(err, { tags: { stage: "process" }, level: "error" });
});
process.on("uncaughtException", (err) => {
    log.error(`uncaughtException: ${err}`);
    captureError(err, { tags: { stage: "process" }, level: "fatal" });
});

log.info(`revision: ${COMMIT}`);

// A yt-dlp binary shipped next to the sources wins over whatever is on PATH.
const ytdlpBin = `${import.meta.dirname}/yt-dlp`;
try {
    Deno.statSync(ytdlpBin);
    try {
        Deno.chmodSync(ytdlpBin, 0o755);
    } catch { /* already executable */ }
    Deno.env.set("YTDLP_PATH", ytdlpBin);
} catch { /* no bundled binary — fall through to PATH */ }
Deno.env.set(
    "PATH",
    `${import.meta.dirname}${Deno.build.os === "windows" ? ";" : ":"}${Deno.env.get("PATH")}`,
);
