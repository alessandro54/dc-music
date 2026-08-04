# music-bot

> **Lightweight, high-performance Discord music bot. Self-hosted. Zero compromise.**

![Deno](https://img.shields.io/badge/Deno-2.x-000000?logo=deno&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![CPU](https://img.shields.io/badge/CPU-~5%25_on_playback-brightgreen)

Most Discord music bots transcode everything through ffmpeg at 256k — even when the audio is already Opus. music-bot streams WebM/Opus directly from YouTube. **ffmpeg never runs for normal playback.**

The result: ~5% CPU instead of 50%. No quality loss. No added latency.

---

## Why music-bot?

- **WebmOpus passthrough** — zero transcoding, lowest CPU of any self-hosted bot
- **Fast enqueue** — metadata sources race in parallel; `/play` answers in ~0.3–1s instead of waiting on yt-dlp
- **One extraction per track** — the streaming yt-dlp reports its own duration, so nothing runs twice
- **In-process search** — YouTube search via youtubei.js (Innertube), no subprocess
- **yt-dlp streaming** — battle-tested, updated daily, handles everything YouTube throws at it
- **Self-hosted** — your server, your data, no subscriptions, no rate limits
- **SQLite out of the box** — no database to set up, works on day one
- **Web dashboard** — live queue, controls, and per-guild config from your browser
- **Spotify support** — tracks, albums, playlists resolved to YouTube automatically
- **Album art** — Now Playing embeds show Spotify/YouTube cover art

---

## Features

- Play from YouTube (URL, search, playlist) or Spotify (track, album, playlist)
- Queue with position tracking, skip, seek, pause/resume, stop
- `/np` — now playing embed with album art + inline buttons
- Autocomplete returns live YouTube video results (title + duration); recent history when empty
- Song history (SQLite by default)
- Web dashboard with live queue + skip/pause/stop controls
- Per-guild config (welcome channel, rules channel) via dashboard or `/setup`
- `/debug` — owner-gated health snapshot (memory, live streams, queue state)
- Resilient playback: stall watchdog skips a hung stream; auto-retries transient 403s

---

## Quick start

### 1. Create a Discord application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → New Application
2. Bot tab → Add Bot → copy token
3. OAuth2 → URL Generator → `bot` + `applications.commands` → invite to your server

### 2. Configure

```env
# .env
BOT_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_ID=your_server_id

# Optional — Spotify support
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# Optional — override default SQLite path (./bot.db)
# DB_URL=sqlite:./custom.db

# Optional — restrict /debug to a single Discord user id (admin-only otherwise)
OWNER_ID=

# Optional — protect the web dashboard
DASHBOARD_TOKEN=your_secret_token

# Optional — YouTube cookies (bypass bot detection on datacenter IPs)
# Export from browser as Netscape format, paste full content here
YOUTUBE_COOKIES=
```

### 3. Run

```bash
deno install --allow-scripts
deno task deploy   # register slash commands (once)
deno task dev      # local dev with auto-restart
```

---

## Deployment

Push to `main` — GitHub Actions builds an arm64 image, pushes it to GHCR, and SSHes into
the Dokku host to release it. Slash commands are registered with `deno task deploy`.

**Required GitHub secret:** `DOKKU_SSH_KEY` (in the `production` environment)  
**Required host config:** `BOT_TOKEN`, `CLIENT_ID`, `GUILD_ID`  
**Optional host config:** `SPOTIFY_*`, `TURSO_*`, `OWNER_ID`, `YOUTUBE_COOKIES`, `SENTRY_DSN`

Set them with `dokku config:set music-bot KEY=…`. Full runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Dashboard

The bot serves a web dashboard on `SERVER_PORT` (default `3000`).

```
http://your-host:port/         # now playing + queue controls
http://your-host:port/config   # server configuration
```

If `DASHBOARD_TOKEN` is set, append `?token=<your_token>` to the URL. The token is logged on startup.

---

## Commands

### Music
| Command | Description |
|---------|-------------|
| `/play <query>` | YouTube URL/search, Spotify track/album/playlist |
| `/np` | Now playing with pause/skip/stop buttons |
| `/queue` | Current queue |
| `/skip` | Skip current song |
| `/seek <position>` | Seek to timestamp (`1:30` or `90`) |
| `/pause` / `/resume` | Pause or resume |
| `/stop` | Stop and clear queue |
| `/history` | Last 10 songs played |

### Server
| Command | Description |
|---------|-------------|
| `/setup welcome #channel` | Set welcome channel |
| `/setup rules #channel` | Set rules channel |
| `/setup show` | Show current config |

### Misc
| Command | Description |
|---------|-------------|
| `/poll <question>` | Create a reaction poll |
| `/coinflip` | Flip a coin |
| `/kick` / `/timeout` | Moderation |
| `/serverinfo` | Server stats |
| `/debug` | Health snapshot — memory, live streams, queue state (owner/admin only) |
| `/help` | All commands |

---

## Stack

| | |
|---|---|
| Runtime | Deno 2.x |
| Bot | discord.js v14 |
| Audio | @discordjs/voice · WebmOpus passthrough · ffmpeg for seeks |
| Search | youtubei.js (Innertube), in-process |
| Metadata | raced: history row · Innertube · oEmbed → yt-dlp fallback |
| Streaming | yt-dlp (pip, nightly channel) |
| Database | @db/sqlite (Deno-native) or Turso (libsql) |
| Build | No build step — Deno runs src/ directly |
| CI/CD | GitHub Actions (arm64) → GHCR → Dokku |

---

## Performance

`/play` used to wait on `yt-dlp --dump-json` just to read a title — ~4s before the embed
appeared. Three changes removed that, measured on a 2-core arm64 VM:

| | before | after |
|---|---|---|
| `/play` → embed | 0.8–1.7s | ~0.35s |
| queued → audible | up to 6.9s | ~6ms |

1. **Metadata sources race** instead of chaining. Each one misses often (history miss, Innertube
   bot-gated, oEmbed 404 on unlisted), so a chain paid the sum of the misses; a race pays the
   fastest source that answers.
2. **The streaming extraction reports its own duration** via `--print-to-file`, so a playing track
   never spawns a second yt-dlp. That duplicate was the 6.9s — two extractions of the same video
   competing for two cores while the user waited for sound.
3. **`(url, played_at)` index** — the history lookup in front of every `/play` was a full scan,
   and on a remote database that's a network round-trip.

Every stage logs its own timing (`resolved in Nms`, `metadata via <source> in Nms`, `spawn Nms`)
so a regression shows up as a number rather than a hunch.

---

## Architecture

Layered — commands are thin controllers; logic lives in services, rendering in views.

```
src/
  commands/   slash-command handlers (parse → service → view → reply)
  events/     discord event handlers
  services/   music/ (guildQueue, stream, spotify, resolver, playback), health
  views/      embed builders
  lib/        guards, utils, db, embeds, constants, logger, server, sentry
```

- **Search vs playback split:** `searchVideo` uses Innertube (in-process); `createStream` uses
  yt-dlp. Innertube can't reliably decipher stream URLs in Deno, so yt-dlp stays for playback.
- **Raced metadata:** `fetchVideoInfo` hits an in-memory cache, then races the song-history row,
  Innertube, and YouTube's oEmbed endpoint, falling back to `yt-dlp --dump-json` only when all
  three miss. Chaining them meant every play paid the sum of the misses.
- **Duration for free:** the streaming yt-dlp writes `%(duration)s` to a sidecar file while stdout
  stays pure audio, so a playing track never needs a second extraction. Until it lands, `duration`
  is `null` — views render `—`.
- **Process hygiene:** every spawn is registered and reaped through one path (SIGTERM → await exit
  → SIGKILL fallback) on skip/stop/idle and on shutdown. One-shot metadata calls run under a hard
  deadline — a hung extraction otherwise holds the interaction open and never exits to be reaped.

---

## Development

```bash
deno install --allow-scripts   # install deps
deno task dev                  # run with auto-restart
deno task start                # run without watch
deno task deploy               # register slash commands
deno task test                 # duration sidecar + spawn lifecycle
```

---

## License

MIT
