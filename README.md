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
- **Spotify support** — tracks, albums, playlists resolved to YouTube automatically
- **Album art** — Now Playing embeds show Spotify/YouTube cover art

---

## Features

- Play from YouTube (URL, search, playlist), Spotify (track, album, playlist) or SoundCloud (track, set)
- Queue with position tracking, skip, previous, seek, pause/resume, stop
- `/np` — now playing embed with album art + inline buttons (⏮ ⏯ ⏭ ⏹), restricted to listeners in the channel
- Autocomplete returns live YouTube video results (title + duration); recent history when empty
- Song history and a play leaderboard, deduplicated per track across every way it was queued
- Sensible leaving: stays 5 minutes after the queue empties, 2 minutes after the last human leaves
- Per-guild config (welcome channel, rules channel) via `/setup`
- `/debug` — owner-gated health snapshot (memory, live streams, queue state)
- Resilient playback: stall watchdog retries a hung stream on the authenticated path, then skips it

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
GUILD_ID=your_server_id

# Optional — Spotify support
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# Optional — override default SQLite path (./bot.db)
# DB_URL=sqlite:./custom.db

# Optional — Turso instead of a local file (takes precedence over DB_URL)
# TURSO_DATABASE_URL=
# TURSO_AUTH_TOKEN=

# Optional — restrict /debug to a single Discord user id (admin-only otherwise)
OWNER_ID=

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
the Dokku host to release it. Slash commands register themselves: Dokku runs `deno task
deploy` from the `postdeploy` hook in `app.json` on every release, so a new command ships
with the code that defines it.

A release is gated on a `GET /health` check that only returns 200 once the bot is logged
into Discord — the old container keeps playing until the new one is genuinely connected,
so a bad token fails the deploy instead of shipping a bot that is up but mute.

**Required GitHub secret:** `DOKKU_SSH_KEY` (in the `production` environment)  
**Required host config:** `BOT_TOKEN`, `GUILD_ID`  
**Optional host config:** `SPOTIFY_*`, `TURSO_*`, `OWNER_ID`, `YOUTUBE_COOKIES`, `SENTRY_DSN`

Set them with `dokku config:set music-bot KEY=…`. Full runbook: [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Commands

### Music
| Command | Description |
|---------|-------------|
| `/play <query>` | YouTube URL/search, Spotify track/album/playlist, SoundCloud track/set |
| `/np` | Now playing, with previous/pause/skip/stop buttons |
| `/queue` | Current queue |
| `/skip` | Skip current song |
| `/previous` | Go back to the previous song (current one returns to the front of the queue) |
| `/seek <position>` | Seek to timestamp (`1:30` or `90`) |
| `/pause` / `/resume` | Pause or resume |
| `/stop` | Stop and clear queue |
| `/history` | Last 10 songs deliberately picked (playlist tracks excluded) |
| `/leaderboard` | Most-played tracks |

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
| `/pokemon` | Random Pokémon sprite |
| `/kick` / `/timeout` | Moderation |
| `/serverinfo` | Server stats |
| `/debug` | Health snapshot — memory, live streams, queue state (owner/admin only) |
| `/setcookies` | Hot-reload YouTube cookies from an uploaded cookies.txt (owner only) |
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
| Database | Drizzle ORM over @libsql/client — local file, or Turso over HTTP |
| Build | No build step — Deno runs src/ directly |
| CI/CD | GitHub Actions (arm64) → GHCR → Dokku |

---

## Performance

Every number below is measured on the production box — a 2-core Oracle Ampere
arm64 VM — not estimated.

| | before | after |
|---|---|---|
| `/play` → embed | 0.8–1.7s | **~0.5–1.0s** |
| cold play → first audio | 7.4s | **~2s** (~8s when it falls back) |
| queued → audible | up to 6.9s | ~0 |

**Enqueue.** Metadata sources race instead of chaining — history row, Innertube
and oEmbed in parallel, yt-dlp only if all three miss. Each misses often enough
that a chain paid the sum of the misses; a race pays the fastest answer, ~30ms.
The reply is a single Discord round-trip: the embed *is* the acknowledgement,
rather than "🔍 Searching…" followed by an edit. At that point Discord's own
latency is the floor, not our work.

**Time to audio.** A cold play tries cookie-free through a proxy first (~2s) and
falls back to the cookie-authenticated path (~7.4s) if no audio arrives. Cookies
cost ~6s — an authenticated session makes YouTube demand the full player-JS and
nsig chain — but the cookie-free path only works on ~75% of unseen videos, so
both halves earn their place. `createStream` waits for a real first byte before
handing the stream to the player, which is what makes the fallback affordable:
a miss costs under a second instead of a 25s stall.

**Process discipline.** Playback is sequential and every spawn is reaped under a
deadline. A second concurrent yt-dlp on two cores directly delays the audio
someone is waiting for — that was the 6.9s.

Every stage logs its own timing (`resolved in Nms`, `metadata via <source> in
Nms`, `audio in Nms`) so a regression shows up as a number rather than a hunch.
Full topology and the measurements behind each choice:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Architecture

Container topology, sidecars, and the measurements behind them:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Standalone deployment:
[`docker-compose.yml`](docker-compose.yml).

Layered — commands are thin controllers; logic lives in services, rendering in views.

```
src/
  index.js      the boot sequence, and nothing else
  bootstrap.js  process handlers, Sentry.init, yt-dlp path — imported first, on purpose
  discord/      everything that knows about discord.js
    commands.js / events.js   the two route tables; nothing scans the filesystem
    client.js / shutdown.js   client construction, signal handling
    commands/   slash-command handlers (parse → service → view → reply)
    resolvers/  /play input → songs, one module per source
    services/   ytdlp, metadata, innertube, stream, playback, spotify, artwork, tracks
    views/      embed builders
    guildQueue.js + queuePlayerEvents.js   one guild's playback state machine
  db/           drizzle schema, migrations, client
  lib/          logger, sentry, config, constants, media/url helpers, errors
```

- **Leaving on purpose:** the queue emptying starts a 5-minute timer, and the last human
  leaving the voice channel starts a 2-minute one. Both are grace periods, not instants — a
  client reconnect reads as an empty channel, and tearing the queue down for that would lose
  the song list.
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
deno task test                 # unit tests (stubbed, no network)
deno task check                # fmt --check + lint + type check
deno task lint:fix             # includes the import sorter (a local lint plugin)
```

---

## License

MIT
