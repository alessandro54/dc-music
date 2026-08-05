import * as Sentry from "@sentry/deno";

import { COMMIT } from "@/lib/buildInfo.js";
import { log } from "@/lib/logger.js";

const DSN = Deno.env.get("SENTRY_DSN");
export const sentryEnabled = Boolean(DSN);

// Keeps local runs out of the production issue stream. The Docker image sets
// NODE_ENV=production, so the split is automatic; SENTRY_ENVIRONMENT overrides
// it (e.g. a staging app on the same Dokku host).
const ENVIRONMENT = Deno.env.get("SENTRY_ENVIRONMENT") ??
    (Deno.env.get("NODE_ENV") === "production" ? "production" : "development");

// Expected teardown noise, not incidents: _killStream SIGTERMs yt-dlp/ffmpeg on
// every skip/stop/seek, so the piped streams always die mid-write by design.
const TEARDOWN_RE = /premature close|broken pipe|abort|resource closed|connection reset|epipe|stream closed/i;

// Discord interaction tokens expire after 3s and can't be acked twice. Both are
// latency artifacts the user already sees — they don't need a Sentry issue.
const IGNORED_DISCORD_CODES = new Set([10062, 40060]);

function isNoise(err) {
    if (!err) return false;
    if (IGNORED_DISCORD_CODES.has(err.code)) return true;
    return TEARDOWN_RE.test(err.message ?? String(err));
}

if (sentryEnabled) {
    Sentry.init({
        dsn: DSN,
        release: COMMIT,
        environment: ENVIRONMENT,
        // Errors only — no performance quota burn.
        tracesSampleRate: 0,
        // GlobalHandlers rethrows after flushing, which would kill a process that
        // currently survives uncaught errors. index.js reports those by hand.
        integrations: (defaults) => defaults.filter((i) => i.name !== "GlobalHandlers"),
        beforeSend: (event, hint) => (isNoise(hint?.originalException) ? null : event),
    });
    log.info(`sentry enabled — ${ENVIRONMENT} @ ${COMMIT}`);
}

// Capture an error with tags/extra. No-op without a DSN, so local dev stays quiet.
export function captureError(err, { tags, extra, user, level } = {}) {
    if (!sentryEnabled || isNoise(err)) return;
    Sentry.captureException(err, { tags, extra, user, level });
}

// Non-throwing conditions worth an issue (stalled stream, dropped track).
export function captureWarn(message, { tags, extra, user } = {}) {
    if (!sentryEnabled) return;
    Sentry.captureMessage(message, { tags, extra, user, level: "warning" });
}

// Per-event user — passed into the capture call rather than set on the global
// scope, so concurrent interactions can't leak each other's identity.
export function userFrom(interaction) {
    return { id: interaction.user.id, username: interaction.user.tag };
}
