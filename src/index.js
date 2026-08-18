// Side effect, and deliberately first: process error handlers, Sentry.init and
// the yt-dlp binary path, all of which must be in place before the service
// modules below are evaluated. See bootstrap.js.
import "@/bootstrap.js";

import { initDb } from "@/db/client.js";
import { createClient } from "@/discord/client.js";
import { warmToken } from "@/discord/services/spotifyService.js";
import { logCookieHealth } from "@/discord/services/ytdlpService.js";
import { installShutdownHandlers } from "@/discord/shutdown.js";
import { startHealthServer } from "@/lib/health.js";
import { log } from "@/lib/logger.js";

await initDb();

const client = createClient();

// Not awaited, and a failure is fine: without Spotify the bot simply falls back
// to YouTube thumbnails. This only removes the token fetch from the first
// artwork lookup's critical path.
warmToken().catch((err) => log.warn(`spotify token warm-up failed: ${err.message}`));

// Also not awaited, and it changes nothing about how the bot runs — it only
// makes an expired cookie jar say so at boot. Without it a dead session is
// invisible until someone plays a gated video, and then it reads as yt-dlp
// breakage rather than "re-export the cookies".
logCookieHealth().catch((err) => log.warn(`cookie health check failed: ${err.message}`));

// Started before login on purpose, so the port is already answering 503 while
// Discord connects — Dokku's healthcheck needs something to poll from the moment
// the container starts, not once the bot is up.
startHealthServer(Deno.env.get("PORT") || 3000, client);

installShutdownHandlers(client);

client.login(Deno.env.get("BOT_TOKEN"));
