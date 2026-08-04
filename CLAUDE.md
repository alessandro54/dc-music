# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Personal Music Discord Bot

Personal Discord bot self-hosted on a **Dokku VPS** (Oracle Cloud, arm64). Full
deploy/runbook in `docs/DEPLOY.md`.

## Stack
- discord.js v14
- Deno (runtime, local dev + production)
- Docker (deployment) — Dokku `git:from-image` from GHCR
- youtubei.js (Innertube) — fast-path YouTube search + metadata (falls back to yt-dlp)
- yt-dlp (pip-installed in image, **nightly channel** via `--pre`) — audio streaming + playlist dump + metadata fallback
- bgutil PO-token provider (Docker sidecar) + EJS solver — YouTube bot-detection / nsig bypass
- ffmpeg — transcode on seek only

## Bot Info
- App ID: 1513765585794895872
- Token: stored in .env as `BOT_TOKEN`
- Guild ID: 414892529427939338

## Commands
- `deno task dev` — run with auto-restart (src/ directly)
- `deno task deploy` — register slash commands with Discord API

## .env / Dokku config Required Keys
```
BOT_TOKEN=                   # code logs in with BOT_TOKEN only (NOT DISCORD_TOKEN)
CLIENT_ID=1513765585794895872
GUILD_ID=414892529427939338
TURSO_DATABASE_URL=          # libsql://… — selects Turso adapter (prod DB)
TURSO_AUTH_TOKEN=            # full-access
SPOTIFY_CLIENT_ID=           # for /play with Spotify track/playlist/album URLs
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REFRESH_TOKEN=       # user-authorized token for playlist reads — `deno task spotify-auth` to generate
YTDLP_POT_BASE_URL=          # http://bgutil-provider:4416 — PO-token provider sidecar
YOUTUBE_COOKIES=             # Netscape cookies — REQUIRED on this datacenter IP (LOGIN_REQUIRED)
DASHBOARD_TOKEN=             # gates the web dashboard control endpoints
OWNER_ID=                    # Discord user id allowed to run /debug (admin-only + owner-gated)
SENTRY_DSN=                  # optional — error monitoring (org alessandro54, project music-bot); unset = SDK no-op
# SENTRY_ENVIRONMENT=        # optional override; defaults to NODE_ENV=production ? production : development
# DB_URL=sqlite:<path>       # only if not using Turso (local dev fallback ./bot.db)
```

## Architecture

Layered. Commands are thin controllers; logic lives in services; rendering in views.

```
src/
  commands/  slash-command handlers — parse interaction → call service → render view → reply
  events/    discord event handlers
  services/  domain + infra: guildQueue (playback engine + queues Map), stream (yt-dlp/Innertube),
             spotify, resolver (query → songs), playback (getOrCreateQueue/enqueue)
  views/     response/embed builders (musicEmbeds)
  lib/       shared helpers: guards (interaction guards), utils (formatting), db, embeds,
             constants, logger, server, buildInfo, config, sentry (error monitoring)
```

Keep commands dumb: validate input, delegate to a service, render a view. Services have no
discord-interaction coupling (guards are the deliberate exception). `play.js` is the reference
pattern (`ensureVoice` → `resolveQuery` → `getOrCreateQueue`/`enqueue` → `trackQueued`/`playlistQueued`).

`src/index.js` statically imports all commands and events. **When adding a new command or event, you must manually add the import and register it in index.js.**

**Commands** (`src/commands/*.js`) — each file exports default `{ data, execute }` (+ optional `autocomplete`):
- `data` — `SlashCommandBuilder` instance
- `execute(interaction, client)` — handler

After adding/changing commands, run `deno task deploy` to register with Discord.

**Events** (`src/events/*.js`) — each file exports default `{ name, once?, execute }`:
- `name` — Discord.js event name
- `once: true` — fires once only
- `execute(...args, client)` — client appended as last arg

## Build & Deploy

No build step — Deno runs `src/index.js` directly. `deno.json` defines tasks and JSR imports (`@db/sqlite`). `deno.lock` pins all dependencies.

CI (`.github/workflows/deploy.yml`) runs on push to `main` (when `src/**/*.js`, `deno.json`, `deno.lock`, `Dockerfile`, or the workflow change), on a **weekly schedule** (Mon 06:00 UTC, keeps yt-dlp fresh), and via `workflow_dispatch`:
1. Build image on a **native arm64 runner** (`ubuntu-24.04-arm`), push to `ghcr.io/alessandro54/discord-music`
2. SSH into the Dokku host (`appleboy/ssh-action`) → `sudo dokku git:from-image music-bot <image>:<sha>`

Scheduled runs pass a `CACHEBUST` build-arg so the pip layer re-pulls the latest yt-dlp; pushes keep the layer cached for fast builds. The pip install uses `--pre` (nightly) — YouTube extractor fixes land there first and stable trails by weeks, so a stable-only image is effectively stale for exactly the breakage that matters. Check what's actually running with `sudo docker exec music-bot.web.1 yt-dlp --version`.

**Pushing to `main` triggers a production deploy that restarts the live bot. Never push without explicit approval.**

Secrets: GitHub **`production` environment** secret `DOKKU_SSH_KEY` (raw private key); GHCR push uses the auto `GITHUB_TOKEN` (image is public). Runtime secrets live on the host (`dokku config:set music-bot …`), not baked into the image.
DB is **Turso** (remote) — no volume. See `docs/DEPLOY.md` for the full setup, the PO-token provider sidecar, and troubleshooting.

## VM & Memory
- VM: Oracle Cloud Ampere (arm64), **12GB RAM** — no memory pressure. The old 512MB Fly heap cap (`--max-old-space-size=160`) has been removed from the Dockerfile CMD.
- **Process hygiene still matters.** Each play spawns yt-dlp (now pip, a python child). `GuildQueue._killStream` → `destroyResource` (`services/stream.js`) reaps it: closes the output stream (EOF), SIGTERM, awaits `.status`, SIGKILL fallback after 2s. Don't regress — leaked procs are sloppy even with headroom.
- Playback is sequential — only one yt-dlp alive at a time.

## Audio Pipeline (`src/services/`)
- `fetchVideoInfo` (`stream.js`) → **in-memory cache → `song_history` row → Innertube `getBasicInfo` → oEmbed → yt-dlp `--dump-json`**. Measured on the prod IP: Innertube metadata is `LOGIN_REQUIRED` for ~5 of 6 videos (60ms, no title), oEmbed answers in ~37ms, yt-dlp takes 3.7–5.0s. oEmbed carries no duration, so `resolver.js` kicks `backfillDuration` in the background and mutates the queued song once yt-dlp answers — `duration` is therefore `null` for a few seconds and every view must tolerate it.
- `searchVideos` → still Innertube.
- `createStream` → **yt-dlp** subprocess streams webm/opus (`StreamType.WebmOpus`, no transcode). Seek path pipes through ffmpeg.
- `fetchPlaylistItems` → yt-dlp `--flat-playlist --dump-json`.
- **Every yt-dlp call** carries shared arg groups: `COOKIES_ARGS` (`YOUTUBE_COOKIES`), `POT_ARGS` (`YTDLP_POT_BASE_URL` → bgutil provider), `EJS_ARGS` (`--remote-components ejs:github`, nsig solver via deno), plus `--retries`/`--extractor-retries`.
- YouTube access on this IP needs **all three**: cookies (past `LOGIN_REQUIRED`) + PO token (GVS) + EJS (signature/nsig). Missing any → no audio. See `docs/DEPLOY.md`.
- Playback is sequential — only one yt-dlp alive at a time. Albums/playlists are a metadata queue (`GuildQueue.songs`); Spotify tracks resolve to YouTube lazily in `_playNext`.

## Database (`src/lib/db.js`)
- Adapter pattern. `initDb` picks: **Turso** if `TURSO_DATABASE_URL` is set (or `DB_URL` starts with `libsql://`), else **SQLite** (`@db/sqlite`) from `DB_URL` (`sqlite:<path>`, default `./bot.db`). mysql adapter removed.
- Turso uses `@libsql/client/web` (pure-HTTP Hrana, no native bindings — Deno/Docker safe). Secrets: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (full-access, not read-only).
- Switching to Turso does **not** migrate existing `/data/bot.db` rows — history starts fresh on Turso.
- Both adapters coerce `undefined` binds to `null` (`@db/sqlite` rejects undefined).

## YouTube Cookies
The Oracle datacenter IP is **hard-flagged** — every yt-dlp client returns `LOGIN_REQUIRED`, so authenticated cookies are **required** (not optional). PO token + EJS alone don't bypass the login gate; cookies do. The three work together: cookies get past login, the PO-token provider refreshes the session (extends cookie life), EJS solves nsig.
Export Netscape cookies from an **incognito** window logged into a throwaway YouTube account (open one video, export, close the window without further browsing — keeps the session token from rotating, so cookies last far longer), then on the host:
```bash
sudo dokku config:set music-bot YOUTUBE_COOKIES="$(cat cookies.txt)"
```
`stream.js` writes them to `/tmp/yt-cookies.txt` and wires `COOKIES_ARGS`. When `/play` fails with "Sign in to confirm", re-export and re-set. Full procedure + the PO-token provider sidecar setup: `docs/DEPLOY.md`.

## Server Structure
- 📢 COMMUNITY: #welcome (ID: 902775878075940905), #general, #announcements, #introductions, #memes, #media
- 🎮 GAMING: #looking-for-group, #game-reviews, #clips, voice: General 1/2, Fortnite, delo, Quarantine (AFK)
- 🏆 LEAGUE OF LEGENDS: #lol-chat, #rank-flex, voice: Solo/Duo, Flex 3/5
- 🎵 MUSIC: #music-control (slash commands only), voice: Music
- 💬 OFF-TOPIC: #off-topic, #spam

## Notes
- `#music-control` is slash-commands-only — MESSAGE_SEND denied for @everyone
- Quarantine voice = AFK channel
- Intents (see `src/index.js`): Guilds, GuildMembers, GuildVoiceStates
