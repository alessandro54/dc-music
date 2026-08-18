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
- ffmpeg — transcode on seek, and for any non-YouTube source (SoundCloud is m4a/AAC over HLS)

## Bot Info
- App ID: 1516232025210753074 (bot user `delo` — the only bot in the guild)
- Token: stored in .env as `BOT_TOKEN`
- Guild ID: 414892529427939338

## Commands
- `deno task dev` — run with auto-restart (src/ directly)
- `deno task deploy` — register slash commands with Discord API. **Runs automatically on every
  production deploy** via the Dokku `postdeploy` hook in `app.json`, so this is only needed for
  local/manual registration. It resolves the application id from `BOT_TOKEN` (an app id *is* its
  bot user's id) rather than reading `CLIENT_ID` — a stale id publishes commands to an app that
  isn't in the guild, and the only symptom is a command that silently never appears.
- `deno task lint:fix` — `deno lint --fix`. Applies the **import sorter**, a local lint plugin
  (`scripts/lint/sort-imports.js`, wired via `lint.plugins`). Neither `deno fmt` nor `deno lint` sorts
  imports and Biome is gone, so a plugin with a `fix()` is the only in-toolchain way to get it. Order is
  bare specifiers, blank line, then `@/`, alphabetical within each group. **Two kinds of import are pinned
  and never move**: one with a comment above it (the comment explains the position, and sorting would
  strand it) and a side-effect import (`import "x"`). That exists because order here is not always
  cosmetic — `@/lib/sentry.js` runs `Sentry.init` on evaluation, and `src/index.js` deliberately imports
  `@/bootstrap.js` (which pulls in sentry) ahead of the service modules whose top-level code it is
  meant to capture. `deno task check` now fails on
  unsorted imports, so run `lint:fix` before it.
- `deno task fmt` / `deno task lint` / `deno task check` — **`deno fmt` + `deno lint`, no Biome.** Biome was config-only (nothing installed it, no CI step, no task), so it was deleted; the `biome-ignore` pragma in `spriteImageService.js` became a `deno-lint-ignore`. `fmt` is scoped to `src/`, `tests/`, `scripts/`, `drizzle.config.js` with `indentWidth: 4` / `lineWidth: 110` to match the existing style — **Markdown and YAML are deliberately out of scope** (`deno fmt` prose-reflows `.md`, which was 879 diff lines across the docs). `src/db/migrations/` is excluded too. `require-await` is off: `async execute` is the handler contract (the dispatcher awaits every one), so the rule flags convention, not bugs.
- `deno task test` — `tests/music/` (duration sidecar, spawn lifecycle, fast-path fallback). Stubs `Deno.Command`, no network. The three stale `bun:test` files were deleted; they had not been runnable since the `services/` move.
- `tests/e2e/stream.e2e.js` — real yt-dlp against real YouTube, so it only means anything **inside the deployed container**: `docker cp` it in, then `dokku enter music-bot web deno run --allow-all …`. It pulls 1.5MB deliberately: reading only the first 64KB is what let a truncated-stream bug ship.

## .env / Dokku config Required Keys
```
BOT_TOKEN=                   # code logs in with BOT_TOKEN only (NOT DISCORD_TOKEN)
GUILD_ID=414892529427939338     # which guild the slash commands register to
TURSO_DATABASE_URL=          # libsql://… — selects Turso adapter (prod DB)
TURSO_AUTH_TOKEN=            # full-access
SPOTIFY_CLIENT_ID=           # for /play with Spotify track/playlist/album URLs
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REFRESH_TOKEN=       # user-authorized token for playlist reads — `deno task spotify-auth` to generate
YTDLP_POT_BASE_URL=          # http://bgutil-provider:4416 — PO-token provider sidecar
YOUTUBE_COOKIES=             # Netscape cookies — REQUIRED on this datacenter IP (LOGIN_REQUIRED)
OWNER_ID=                    # Discord user id allowed to run /debug (admin-only + owner-gated)
SENTRY_DSN=                  # optional — error monitoring (org alessandro54, project music-bot); unset = SDK no-op
# SENTRY_ENVIRONMENT=        # optional override; defaults to NODE_ENV=production ? production : development
# DB_URL=sqlite:<path>       # only if not using Turso (local dev fallback ./bot.db)
```

## Architecture

Container topology + sidecar rationale with measurements: `docs/ARCHITECTURE.md`.
Standalone/reproducible stack: `docker-compose.yml`.

Layered. Commands are thin controllers; logic lives in services; rendering in views.
Three top-level dirs, each with a rule for what belongs in it:

```
src/
  index.js     boot script only: initDb → createClient → warm token → health server →
               shutdown handlers → login. Nothing else belongs here
  bootstrap.js side-effect module imported *first* by index.js: process error handlers,
               Sentry.init (via lib/sentry.js), yt-dlp binary path + PATH. Ordering is
               load-bearing — `ytdlpService` reads `YTDLP_PATH` at module scope, so setting
               it after the imports would be too late
  discord/     the Discord domain — everything that knows about discord.js
    client.js    createClient() — intents, cache limits, command collection, registerEvents, setClient
    events.js    the event table — every event handler imported and listed here, and nowhere else
    shutdown.js  installShutdownHandlers(client) — SIGTERM/SIGINT: destroy queues, reap yt-dlp, logout
    commands.js  the route table — every command imported and grouped here, and nowhere else
    router.js    defineCommand (route + guard middleware) and createRouter (grouping)
    commands/  slash-command handlers — parse interaction → call service → render view → reply.
               Grouped by nature: playback/ (play/, controls (pause/resume/skip/stop), previous,
               seek, queue, np, history), tracks/ (leaderboard), moderation/ (kick, timeout),
               fun/ (coinflip, poll, pokemon), admin/ (debug, setcookies, setup),
               info/ (help, serverinfo)
    events/    discord event handlers
    reply.js   ephemeral(content) — the caller-only reply payload used for refusals
    services/  flat, and **every file is `<name>Service.js`** — the suffix is the convention, no
               exceptions. The yt-dlp stack is split by responsibility (see Audio Pipeline):
               ytdlpService (process spawn/registry/reap, arg sets, cookie + proxy policy),
               metadataService (title/duration/artwork, the raced sources, playlist dump,
               duration backfill), innertubeService (Innertube client + search), streamService
               (URL → AudioResource, ffmpeg transcode, teardown). Plus playbackService
               (the queues Map + bot presence + getOrCreateQueue/enqueue),
               spotifyService (Web API client), trackService (song_history queries),
               artworkService (square album art), healthService, pokemonService,
               spriteImageService (PNG compositing)
    resolvers/ /play input → songs, one module per source — see below. Sits *above* services:
               it orchestrates them (streamService, spotifyService), so it isn't one itself
    views/     response/embed builders (musicEmbeds, healthEmbed, embeds)
    guards.js  interaction guards (ensureVoice etc.)
    buttons.js component routes — the `np:<action>` table behind the Now Playing buttons,
               plus the same-voice-channel check. Buttons are not commands: they never
               reach the router, so their guard lives here
    queuePlayerEvents.js  the AudioPlayer transitions for one GuildQueue (stall watchdog,
               first-audio timing, advance-on-Idle, player error). Split out of the constructor,
               where it was 110 inline lines; it touches queue internals on purpose. Changes when
               *playback transitions* change, while guildQueue.js changes when the queue's shape does
    guildQueue.js  the GuildQueue **entity** — one guild's playback state machine (song list,
               played stack, audio player, the timers). Deliberately *not* a service and not
               in services/: it owns per-guild state, one instance per active guild. It holds no
               module globals — it reports up via `onDestroy`/`onChange` callbacks, and
               playbackService owns the registry and the presence those callbacks drive
  db/          persistence: client (adapter pick + migrate on boot), schema, migrations/
  lib/         importable by any layer, knows nothing about the app: logger, sentry, config,
               constants, utils (formatting), media (url/duration helpers), buildInfo,
               errors (UserFacingError)
```

`lib/` means "no domain knowledge, no I/O boundary" — if a file imports `discord.js` or owns a
connection, it belongs in `discord/` or `db/`, not here. Every file in `lib/` now satisfies that:
`server.js`, the one exception, went with the dashboard.

**Imports use the `@/` alias** (`"@/": "./src/"` in `deno.json`) — e.g. `import { log } from "@/lib/logger.js"`.
No relative `../` imports; the sweep that removed them also covers `tests/` and `tests/e2e/`, so run the
e2e from `/app` in the container (where `deno.json` is) or the import map won't resolve.

Keep commands dumb: validate input, delegate to a service, render a view. Services avoid
discord-interaction coupling (`guildQueue` needs `@discordjs/voice`; guards are the deliberate
exception).
`play/index.js` is the reference pattern (`ensureVoice` → `resolveQuery` → `getOrCreateQueue`/`enqueue` →
`trackQueued`/`playlistQueued`).

### Resolvers (`src/discord/resolvers/`)

`/play` input → `{ songs, playlistName }`. One module per source, each exporting `matches(query)` and
`resolve(query, requestedBy, requestedById)`; `index.js` picks the first match and falls back to
**YouTube search** for plain text. Adding a source means adding a file and listing it in `RESOLVERS`.

- `youtube.js` — video URL, `?list=` playlist, and the `search()` fallback
- `spotify.js` — owns the URL regexes (incl. the `/intl-xx/` locale segment) and the track/playlist/album
  branching; songs carry `spotifyTrack` and resolve to YouTube lazily in `GuildQueue._playNext`, not at
  queue time. Also exports `trackMeta` for the autocomplete label. **HTTP lives in
  `services/spotifyService.js`** (tokens + endpoints, named methods, no `/play` knowledge) — the old
  single `spotify.js` was both an API client and a resolver, which is what made
  `resolvers/spotify` → `services/spotify` read as circular
- `soundcloud.js` — track URLs and `/sets/` (also `m.soundcloud.com`, `snd.sc`), via yt-dlp

**SoundCloud needs the ffmpeg transcode, and says so itself.** Measured: it serves **m4a/AAC over HLS**,
not webm/opus, so handing yt-dlp's stdout straight to Discord as `StreamType.WebmOpus` would play silence.
The resolver therefore sets **`transcode: true` on its songs**, `GuildQueue._playNext` passes it to
`createStream`, and the same ffmpeg pipeline seeking already used kicks in (opus 48kHz stereo,
`StreamType.Arbitrary`). **Declaring it on the song is what keeps `streamService` free of per-source
special cases** — a new source needs no edit there. `createStream` still falls back to a `!isYouTubeUrl`
sniff when the flag is absent, purely as a safety net: a source that forgets it would otherwise play
silence, the worst failure mode. Verified end to end: SoundCloud spawns 2 procs (yt-dlp + ffmpeg),
YouTube spawns 1, and a non-YouTube URL with no flag still gets 2.
Two more non-YouTube consequences, both handled: the metadata race (DB/Innertube/oEmbed) is YouTube-only
so other sources use `fetchTrackInfo` (yt-dlp alone), and `ytThumb` must not be used on a foreign id —
it would invent a youtube URL that 404s.

**Commands** (`src/discord/commands/<group>/*.js`) — each file exports `defineCommand({...})` from `router.js`:
- `name` / `description` — build the `SlashCommandBuilder` for you
- `options: (b) => …` — receives the real builder, so subcommands/choices/min-max all still work
- `permissions` — `setDefaultMemberPermissions` (hides the command in the picker)
- `guard` — route middleware from `guards.js`: returns the value the handler needs, or `null` after
  replying with the reason. **This replaces the `if (!queue) return` prologue**, so a handler can't
  forget it. Available: `requirePlaying`, `requireCurrent`, `ensureVoice`, `requireOwner`
- `handler(interaction, guardValue)` — no `client` argument; use `interaction.client`
- `autocomplete` — optional, passed straight through

`pause`/`resume`/`skip`/`stop` are the same route three steps long, so they're declarations in
`playback/controls.js` rather than four near-identical files.

### Adding a new command

Two files, in this order. Nothing scans the filesystem — the route table is the only registry, which
is why `deno check` still sees the whole graph.

**1. Write the command** in `src/discord/commands/<group>/<name>.js`. Pick the group by nature
(`playback`, `moderation`, `fun`, `admin`, `info`); make a new one only if none fit.

```js
import { requirePlaying } from "@/discord/guards.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";

export default defineCommand({
    name: "volume",                       // must match the filename and be unique
    description: "Set playback volume",
    options: (b) =>                       // omit entirely if the command takes no input
        b.addIntegerOption((o) =>
            o.setName("percent").setDescription("0-200").setRequired(true).setMinValue(0).setMaxValue(200)
        ),
    guard: requirePlaying,                // omit if the command needs no precondition
    handler: async (interaction, queue) => {
        const percent = interaction.options.getInteger("percent");
        if (!queue.setVolume(percent)) return interaction.reply(ephemeral("Could not set volume."));
        await interaction.reply(`🔊 Volume set to **${percent}%**.`);
    },
});
```

**2. Register it** in `src/discord/commands.js` — add the import and drop it in a group's array:

```js
import volume from "@/discord/commands/playback/volume.js";
// …
.include("playback", [play, pause, resume, skip, stop, seek, volume, queue, np, history], { label: "🎵 Music" })
```

Registering is also what puts it in `/help` (rendered from the router's groups), so there is no help
list to update. Order inside the array is the order `/help` prints.

**3. `deno task check`.** Registering with Discord happens by itself — the Dokku `postdeploy` hook
in `app.json` runs `deployCommands.js` on every release. Run `deno task deploy` by hand only to see
the command before it ships.

Notes:
- **A duplicate or missing `name` throws at startup**, not silently — the router validates on `include`.
- Need a precondition that doesn't exist yet? Add a guard to `guards.js` (return the value, or reply and
  return `null`) rather than an `if` at the top of the handler.
- Owner-only tooling goes in the `admin` group: set `permissions` *and* `guard: requireOwner`. The group
  is `hidden`, so it stays out of `/help`.
- No `client` parameter — use `interaction.client`.
- **Events are registered in `src/discord/events.js` by hand** (import + add to the `events` array);
  only commands go through the router.

**Events** (`src/discord/events/*.js`) — each file exports default `{ name, once?, execute }`:
- `name` — Discord.js event name
- `once: true` — fires once only
- `execute(...args, client)` — client appended as last arg

## Build & Deploy

No build step — Deno runs `src/index.js` directly. `deno.json` defines tasks, the `@/` alias, and npm/JSR imports. `deno.lock` pins all dependencies.

CI (`.github/workflows/deploy.yml`) runs on push to `main` (when `src/**/*.js`, `deno.json`, `deno.lock`, `Dockerfile`, or the workflow change), on a **weekly schedule** (Mon 06:00 UTC, keeps yt-dlp fresh), and via `workflow_dispatch`:
1. Build image on a **native arm64 runner** (`ubuntu-24.04-arm`), push to `ghcr.io/alessandro54/discord-music`
2. SSH into the Dokku host (`appleboy/ssh-action`) → `sudo dokku git:from-image music-bot <image>:<sha>`
3. A `prune` job keeps only the **5 most recent GHCR versions** (`actions/delete-package-versions`,
   max 100 deletions per run). `provenance: false`/`sbom: false` on the build keep that 1 version
   per build instead of 3 — attestations made buildx push an OCI index plus two untagged children.

`app.json` also carries a **`startup` healthcheck**: Dokku polls `GET /health` on port 3000, 12 × 5s.
`src/lib/health.js` serves that one route and nothing else (`EXPOSE 3000` exists for it alone) —
**it is not the dashboard returning**. 200 only once `client.isReady()`, 503 while connecting, which
is the part that buys zero-downtime: the old container keeps playing until the new one is genuinely
logged into Discord, so a bad token fails the release instead of shipping a bot that's up but mute.
**Requires `dokku checks:enable music-bot`** — while checks are disabled Dokku ignores `app.json` and
stops the running container outright.

**A `command`-type check does not work here and must not be reinstated.** `test -f /tmp/bot-ready`
was tried first: the `docker-local` scheduler *announces* the check and then never runs it, so the
deploy hung until `appleboy/ssh-action` hit its 600s `Run Command Timeout` — and the Dokku process
kept looping on the host afterwards, holding the app lock so that every later `dokku` command hung
too, needing a manual `pkill`. Dokku's own docs are the warning: "healthcheck implementation depends
on the specific scheduler plugin in use, and not all plugins support every available configuration
option." `path` is this scheduler's supported mode. `initialDelay` is unsupported here as well.

Dokku then runs the `postdeploy` hook from **`app.json`** (which the Dockerfile `COPY`s into the
image — `git:from-image` reads it from there), registering the slash commands. It runs *after* the
release is live, so a Discord outage turns the deploy red without taking the bot down; the script
retries 3× first.

Scheduled runs pass a `CACHEBUST` build-arg so the pip layer re-pulls the latest yt-dlp; pushes keep the layer cached for fast builds. The pip install uses `--pre` (nightly) — YouTube extractor fixes land there first and stable trails by weeks, so a stable-only image is effectively stale for exactly the breakage that matters. Check what's actually running with `sudo docker exec music-bot.web.1 yt-dlp --version`.

**Pushing to `main` triggers a production deploy that restarts the live bot. Never push without explicit approval.**

Secrets: GitHub **`production` environment** secret `DOKKU_SSH_KEY` (raw private key); GHCR push uses the auto `GITHUB_TOKEN` (image is public). Runtime secrets live on the host (`dokku config:set music-bot …`), not baked into the image.
DB is **Turso** (remote) — no volume. See `docs/DEPLOY.md` for the full setup, the PO-token provider sidecar, and troubleshooting.

## VM & Memory
- VM: Oracle Cloud Ampere (arm64), **12GB RAM** — no memory pressure. The old 512MB Fly heap cap (`--max-old-space-size=160`) has been removed from the Dockerfile CMD.
- **Process hygiene still matters.** Each play spawns yt-dlp (now pip, a python child). `GuildQueue._killStream` → `destroyResource` (`services/streamService.js`) reaps it via the shared `reap()`: stops the duration poller, closes the output stream (EOF), SIGTERM, awaits `.status`, SIGKILL fallback after 2s. Don't regress — leaked procs are sloppy even with headroom.
- Playback is sequential — only one yt-dlp alive at a time. **This is a performance constraint, not just tidiness:** 2 cores means a second concurrent extraction directly delays the audio the user is waiting on (measured: 6.9s). Anything that spawns yt-dlp off the critical path must stay clear of the streaming spawn.

## Audio Pipeline (`src/discord/services/`)

**The yt-dlp stack is four modules, split by reason-to-change** (it was one 847-line `streamService.js`
with 14 exports and 9 responsibilities; see the SOLID notes at the end of this section):
- `ytdlpService.js` — how a process runs: arg sets (`META_ARGS`, `FULL_EXTRACT_ARGS`, cache/PO-token/EJS),
  cookie policy, proxy health + cooldown, the spawn registry, `reap`, `runYtdlp`, `shutdownStreams`
- `metadataService.js` — what a URL *is*: `fetchVideoInfo` (raced sources + cache), `fetchTrackInfo`
  (non-YouTube), `fetchPlaylistItems`, `backfillDuration`
- `innertubeService.js` — the Innertube client and `searchVideos`/`searchVideo`
- `streamService.js` — `createStream`/`destroyResource` only: spawn → prove audio → wrap in an
  `AudioResource`, plus the ffmpeg transcode and the duration sidecar poller

`streamService` → `metadataService` → `ytdlpService`, no cycles. `lib/media.js` holds the pure helpers
they share (`extractVideoId`, `isYouTubeUrl`, `ytThumb`, `trackKey`, `fmtSecs`).
- `fetchVideoInfo` (`streamService.js`) → in-memory cache, then **`song_history` row, Innertube `getBasicInfo`, and oEmbed raced concurrently** (`Promise.any`), falling back to yt-dlp `--dump-json` only when all three reject. They were chained before; each misses often enough on this IP (DB miss, Innertube `LOGIN_REQUIRED` for ~5 of 6 videos, oEmbed 404 on unlisted) that chaining made every play pay the **sum of the misses**. Raced, a play costs the fastest source that answers. Innertube is capped at 1.5s — it has no deadline of its own.
- **Cold plays go fast-then-slow.** `createStream` first tries cookie-free through the proxy (~2s), and falls back to the cookie-authenticated path (~7.4s) when no audio arrives. Cookies are the ~6s tax — an authenticated session makes YouTube demand the full player-JS + nsig chain — and the cookie-free path only works on ~75% of unseen videos, so both halves are needed.
- **`_awaitFirstByte` is what makes the fallback affordable.** It peeks the first chunk (racing the extractor's exit and a first-byte budget) and puts it back before the resource reaches the player. Without it a dead extraction only surfaced when the 25s stall watchdog fired, which made "try fast, then slow" cost 32s instead of ~8s.
- **The two attempts get different budgets** — `FIRST_BYTE_FAST_MS` 9s, `FIRST_BYTE_COOKIE_MS` 20s. The
  fast attempt is speculative, so a miss must stay cheap; the authenticated one is the last chance, and
  giving up on it drops the track. 9s for both was too tight and failed silently: measured cold to first
  audio, **7757ms / 9089ms through WARP and 8010ms / 7923ms direct** — a coin flip against a 9s ceiling,
  with the proxy *not* the variable. It hid behind the proxy-cooldown bug, which used to knock the hop
  off the retry and shave it under the wire; fixing that attribution is what exposed this.
- **There is deliberately no media-URL cache.** One existed and had to be removed: a googlevideo URL fetched with a plain GET is truncated by the server — on a 4:19 track `clen` said 4,429,008 bytes and a single `fetch` returned 622,592, so playback ended seconds in. yt-dlp ranges its own downloads, which is why it is correct. Reinstating a cache means writing a ranged reader first. Every test at the time read only the first 64KB, which a truncated stream satisfies — hence the e2e now pulls 1.5MB.
- **Duration comes from the streaming extraction, not a second yt-dlp.** `createStream` takes an `onDuration` callback and passes `--print-to-file %(duration)s /tmp/yt-duration-<id>.txt`; stdout stays pure audio and a poller fills the song in place (~2.8s in, measured). The eager `backfillDuration` still exists for tracks queued *behind* others, but waits 2s + until 8s past the last streaming spawn, then re-checks — by then the sidecar has usually answered and it spawns nothing.
- `duration` is therefore `null` for a few seconds on the URL path — **every view must tolerate it** (`song.duration ?? "—"`).
- `searchVideos` → still Innertube.
- `createStream` → **yt-dlp** subprocess streams webm/opus (`StreamType.WebmOpus`, no transcode). Seek path pipes through ffmpeg.
- `fetchPlaylistItems` → yt-dlp `--flat-playlist --dump-json`.
- **Every yt-dlp call** carries shared arg groups: `COOKIES_ARGS` (`YOUTUBE_COOKIES`), `POT_ARGS` (`YTDLP_POT_BASE_URL` → bgutil provider), `EJS_ARGS` (**empty** — the nsig solver ships in the image as `yt-dlp-ejs` via `yt-dlp[default]`; see below), `--proxy` when `YTDLP_PROXY` is set, plus `--retries`/`--extractor-retries`. Metadata calls skip the streaming set and pin `player_client=ios;player_skip=js` + `--ignore-no-formats-error` (1.4–1.8s vs 3.8s) — they need a title and a duration, not a playable format URL.
- **Every spawn goes through the registry in `streamService.js`** — `track()` on spawn, `reap()` (SIGTERM → await `.status` → SIGKILL after 2s) to kill. One-shot calls (`_dumpJson`, `fetchPlaylistItems`) run via `runYtdlp()` under a hard deadline (20s metadata, 60s playlist); `Deno.Command#output()` can't be aborted, and an unbounded call held the `/play` interaction open until Discord expired it while the process sat there for the container's uptime. `shutdownStreams()` (wired to SIGTERM/SIGINT in `index.js`) reaps the lot on redeploy.
- Note on zombies: `docker-init` **is** PID 1 and does reap orphans — tini's "not running as PID 1" warning at every boot is noise here, and the host shows none accumulating. The real risk is a proc that *hangs* rather than exits; nothing reaps that but us, hence the deadlines.
- YouTube access on this IP needs **all three**: cookies (past `LOGIN_REQUIRED`) + PO token (GVS) + EJS (signature/nsig). Missing any → no audio. See `docs/DEPLOY.md`.
- **EJS comes from the image, not from GitHub.** The Dockerfile installs `yt-dlp[default]`, whose dependency group pins `yt-dlp-ejs` to the exact version yt-dlp requires (bare `pip install yt-dlp` declares *no* dependencies at all). `--remote-components ejs:github` is the alternative to that package, not a companion — measured with the package installed, the flag still fetched from GitHub: **9.08s cold vs 2.06s** using the local copy. The container has no volume, so every deploy is a cold cache, and a GitHub outage would have meant no audio. Don't re-add the flag.
- `/data/ytdlp-cache` is a **Dokku bind-mount** (`dokku storage:mount music-bot /var/lib/dokku/data/storage/music-bot-ytdlp-cache:/data/ytdlp-cache`) so yt-dlp's player/sigfunc cache survives deploys. Without it every release started cold.
- Playback is sequential — only one yt-dlp alive at a time. Albums/playlists are a metadata queue (`GuildQueue.songs`); Spotify tracks resolve to YouTube lazily in `_playNext`.

## Leaving & Going Back (`guildQueue.js`, `events/voiceStateUpdate.js`)

Two timers, both in `TIMEOUTS`, both deliberately grace periods rather than instants:

- **`QUEUE_IDLE_MS` (5 min)** — armed by `_advance()` when the queue runs dry. It was 30s, which
  made the bot vanish between songs while someone picked the next one.
- **`ALONE_LEAVE_MS` (2 min)** — armed by `markAlone()` when the last non-bot member leaves the
  bot's own channel, cancelled by `markNotAlone()`. `voiceStateUpdate` only reacts to events
  touching that channel; everything else is noise. **The grace period is the point**: a client
  reconnect or a channel hop reads as a momentarily empty channel, and destroying the queue for
  that loses the whole song list.

Failure paths call `_advance({ idleTimer: false })` — running *out* of songs starts the leave
countdown, failing out of them doesn't.

**A dropped track announces itself.** `_dropTrack` reports up through `onTrackError`, and
`playbackService.announceDrop` posts `⚠️ Skipped **title** — reason` to the channel the last command
came from (tracked in `announceChannels`, not the queue's birth channel). This is not decoration: the
Now Playing embed is sent when a track is **queued**, not when audio arrives, so a silent drop leaves an
embed for a song that never plays while `/np` says "Nothing playing" — indistinguishable from a broken
bot. `UserFacingError` messages are shown as-is; anything else says "it wouldn't start", since the real
cause is a yt-dlp stderr tail nobody in Discord can act on. A send failure only logs — the notification
must never take the queue down.

`/previous` is backed by `queue.played`, an in-memory stack (cap `LIMITS.PLAYED_HISTORY`) filled
by the Idle handler from the track it shifts off. It is **not** `/history`, which is the DB record;
this dies with the queue. `previous()` unshifts the popped track in front of the current one, so
previous → skip returns you where you were, and has two paths: playing (set `_replaying`, then
`player.stop()` — without the flag the resulting Idle would shift the restored track straight back
off) and already-idle inside the grace window (`stop()` emits no Idle at all, so call `_playNext`
directly). A track that *errored* is dropped rather than remembered.

**Buttons** (`discord/buttons.js`) are `np:<action>`, routed through an `ACTIONS` table with a
same-voice-channel guard — they never reach `router.js`, so the guard cannot come from there.
`np:pause` toggles: `nowPlayingControls` renders ▶️ once paused, and calling `pause()`
unconditionally left `/resume` as the only way out. Known wart: the re-render happens before the
queue advances, so the embed briefly shows the outgoing track — fixing it means rendering from
`onChange` instead of inline.

## What Reaches Sentry

`captureError` is filtered by `isNoise` in `lib/sentry.js`, which is the single choke point:

- **`UserFacingError`** (`lib/errors.js`) — a search with no results, a Spotify playlist the app
  can't read. Bad input, not a bug. Filtered centrally *because* queued Spotify tracks resolve
  deep inside `GuildQueue`, far from the command that started them, so a per-call-site check leaks
  them back in. `/play` shows the message instead of its generic refusal.
- **Teardown noise** (`TEARDOWN_RE`) and expired-interaction Discord codes.
- **The cookie-free fast attempt** — its non-zero exit is *expected* on ~25% of unseen videos and
  the caller retries immediately, so `streamService` logs it and returns. One failed play used to
  emit two issues with no way to tell a recovered miss from a dead track. Only the authenticated
  attempt captures, tagged `useCookies`.
- **A login gate never blames the proxy.** `markProxyBad` is skipped when stderr `isLoginGate` — in
  both `streamService`'s stderr watcher and `runYtdlp`'s direct-retry. Observed on prod: one gated
  video put WARP in its 5min cooldown while WARP was healthy, so every play in that window paid the
  slow authenticated route — and when the cookies are what's gated, the fallback it forced cannot work
  either. Captured errors carry a `loginGate` tag, since the message alone can't be told apart.
- The inverse needed adding: when the cookie attempt yields no first byte, *we* kill the extractor,
  and a signalled exit is indistinguishable from a user skip in the stderr watcher. `_verifiedStream`
  reports that case explicitly with the stderr tail, or it would only ever surface as a bare
  "stream produced no audio".

## Enqueue Performance
`/play` → embed is `resolveQuery`. Three log lines make it measurable — don't guess, read them:
```
resolved in Nms                     # /play → embed (commands/play/index.js)
[stream] metadata via <src> in Nms  # which raced source won (db/innertube/oembed/yt-dlp)
· 3:44 · by user · spawn Nms        # createStream → player.play (guildQueue.js)
```
Measured on prod (2-core Ampere):

| | before (27aae5e) | after (a54016e) |
|---|---|---|
| `resolved in` | 830–1650ms | 355ms (search path) |
| `spawn` | — | 38ms |
| Enqueued → audible | up to **6870ms** | 6ms |

The 6.9s gap was the killer and it was **after** the embed, not in enqueue: `backfillDuration`
extracted the same video while the streaming yt-dlp was starting, on 2 cores. Both are gone now
that the streaming extraction reports its own duration.

Caveat on the "after" column: it's **one play, and it took the search path** (`searchVideo` →
Innertube), which was already fast and didn't change. The raced sources and the duration sidecar
are only exercised by a **YouTube URL never played before** — a repeat play hits the cache/DB.
That path is not yet measured on prod.

## Album Art (`services/artworkService.js`)

YouTube serves 4:3/16:9 thumbnails, so a square album cover arrives **padded with
black bars** — which is what the Now Playing embed showed. **Spotify is the single
art provider** for every source: its album images are square 640x640 and the
credentials are already there. Spotify-sourced songs carry their art already;
`artworkService` covers the YouTube paths (single video + search).

- `artworkQuery()` strips packaging before searching — a bracketed group goes only
  if it mentions packaging *and* names no distinct recording, matched on
  *contains* because `(Official 4K Music Video)` interleaves the two. Live, Remix,
  Acoustic, Cover, Instrumental all survive: they should steer the match.
- **Awaited, not backfilled**, so the *first* embed is already right. It fits:
  warm lookups are 400-670ms against `/play`'s 2000ms acknowledge budget
  (measured 840-1552ms end to end). A 1200ms deadline bounds it, and a miss just
  keeps the YouTube thumbnail.
- **`warmToken()` runs at boot** (`index.js`, not awaited). Without it the first
  artwork lookup also mints the OAuth token — measured **2115ms**, which overruns
  the budget and costs the user a second round-trip on the first play after every
  restart.
- **Timeouts are not cached, genuine misses are.** A title Spotify doesn't know is
  remembered as null; a timeout says nothing about the track, and caching the
  cold-start one would blank that cover permanently.
- **Playlists are skipped on purpose** — 100 items would mean 100 lookups for art
  nobody has looked at yet.

## Database (`src/db/`)
- **Drizzle ORM** over `@libsql/client` for both environments. `client.js` = init + client pick; `schema.js` = drizzle table def (source of truth); `migrations/` = drizzle-kit output, applied on boot via `migrate()` (`drizzle-orm/libsql/migrator`). song_history queries live in `src/discord/services/trackService.js` (the one query module — it stays with the domain, not in `db/`) (`saveSong`/`getHistory`/`getRecentSongs`/`getSongMeta`).
- **Schema changes:** edit `schema.js` → `deno task db:generate` (drizzle-kit, config in `drizzle.config.js`) → commit the new `migrations/*.sql` + `meta/`. Never hand-edit applied migrations — exception: `0000` got `IF NOT EXISTS` added by hand because prod Turso already had the table before the migrator existed.
- `initDb` picks: **Turso** via `@libsql/client/web` (pure-HTTP Hrana, no native bindings — Deno/Docker safe) if `TURSO_DATABASE_URL` is set (or `DB_URL` starts with `libsql://`), else **local libsql file** via the default `@libsql/client` entry from `DB_URL` (`sqlite:<path>`, default `./bot.db`). `@db/sqlite` removed.
- Query results are **camelCase** (`userTag`, `playedAt`) per the drizzle schema — not snake_case column names.
- **Every row carries a `fingerprint`** (`lib/media.js` `trackFingerprint`): `yt:<videoId>` for YouTube,
  else the canonical url. One video reached three ways — pasted `youtu.be/X`, `watch?v=X&t=30`, or picked
  from search — used to store three different url strings, which split one song into three rows in
  `/leaderboard`, showed it twice in autocomplete, and made the metadata cache miss its own history.
  Plays are counted and looked up by fingerprint; `url` still records the exact link used.
- Legacy rows are filled by a **background** backfill (`db/client.js`) — `initDb` does *not* await it, and
  `await initDb()` in `index.js` gates `client.login`, so blocking on it would put
  a pile of Turso round-trips in front of the bot connecting (measured: returns in ~1ms now). Grouping
  uses `coalesce(fingerprint, url)`, which is what makes that safe — queries are correct while it is still
  running, verified mid-flight. The UPDATEs are batched 100 at a time because on Turso each `execute()` is
  its own HTTP round-trip; 120 legacy urls became 2 requests instead of 120. A failure only logs: the
  coalesce keeps results right, and the next boot retries.
- **Every row records its `source`** (migration 0003): `"youtube"` | `"spotify"` | `"soundcloud"`. Stamped
  centrally in `resolvers/index.js` from the resolver's own `name`, so a new source is labelled without
  touching that code. It is **provenance, not where the audio came from** — a Spotify request stays
  `"spotify"` even though `_playNext` resolves it to a YouTube video to play, which is precisely why it
  can't be read back off the `url`. Legacy rows are backfilled from the url, so a pre-0003 Spotify request
  reads as `"youtube"`: its origin was never recorded and is unknowable now.
- **Playlist tracks are plays, not picks.** Every row carries `via_playlist` (migration 0002), set by the
  resolvers on playlist/album/set branches and carried through `_playNext` into history. `/history` and
  the `/play` autocomplete suggestions filter it out (`CHOSEN` in trackService) — otherwise one 100-track
  album buries every deliberate pick in both lists. `/leaderboard` still counts them: they *were* played.
  Rows predating the column are NULL, which `is not 1` treats as a pick.
- **Dedup happens in the database**, as one `INSERT … SELECT … WHERE NOT EXISTS` rather than a SELECT
  followed by an INSERT. `saveSong` isn't awaited and a stall-retry re-enters `_playNext` seconds later,
  so the two-step version could interleave — demonstrated: 5 concurrent saves of one track wrote **5 rows**
  with the old code, 1 with this. It is also one round-trip instead of two. Uses `IS` not `=` on the
  fingerprint, since a NULL one never equals itself and would dedup nothing.
- Fingerprints are **deterministic on purpose** — they're persisted, so a fuzzy rule would need every row
  rewritten. Merging separate *uploads* of one song (official video vs a re-upload) is heuristic and
  therefore stays at read time in `mergeVariants`/`normalizeTitle`, where the rule can improve freely.
  That matching is narrow: it strips packaging noise (Official Video, Lyrics, HD) but never Live, Remix,
  Acoustic, Cover or Instrumental, which are genuinely different recordings.
- Secrets: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (full-access, not read-only).

## YouTube Cookies
The Oracle datacenter IP is **hard-flagged** — every yt-dlp client returns `LOGIN_REQUIRED`, so authenticated cookies are **required** (not optional). PO token + EJS alone don't bypass the login gate; cookies do. The three work together: cookies get past login, the PO-token provider refreshes the session (extends cookie life), EJS solves nsig.
Export Netscape cookies from an **incognito** window logged into a throwaway YouTube account (open one video, export, close the window without further browsing — keeps the session token from rotating, so cookies last far longer), then on the host:
```bash
sudo dokku config:set music-bot YOUTUBE_COOKIES="$(cat cookies.txt)"
```
`streamService.js` writes them to `/tmp/yt-cookies.txt` and wires `COOKIES_ARGS`. When `/play` fails with "Sign in to confirm", re-export and re-set. Full procedure + the PO-token provider sidecar setup: `docs/DEPLOY.md`.

**`checkCookieSession()` answers "is the jar still a session?"** — `logCookieHealth()` runs it at boot
(not awaited) and `/setcookies` awaits it so the reply says whether the upload actually worked.
Dead-but-present cookies are the worst case: `hasCookies()` is true, so every play pays the ~7.4s
authenticated route and still fails on exactly the gated videos the cookies existed for, while the
symptom ("Sign in to confirm") reads as extractor breakage.
- The probe is **yt-dlp against `:ythistory`**, which is auth-only, so its answer is about the cookies
  and nothing else. A video probe can't say that — its failure could be the video, the IP or the session.
- **Read stderr, not the exit code.** A rotated session is a *warning with exit 0* on the first call of
  a fresh process (measured: run 1 exited 0 with "The provided YouTube account cookies are no longer
  valid… rotated in the browser", runs 2-3 exited 1 with "Login details are needed"). Since the check
  runs once per boot, an exit-code-first version reports live cookies every time. A *clean* exit 0 —
  neither complaint present — is the pass. Printed items are **not** required: the throwaway account
  has an empty watch history, so a good jar returns exit 0 with no stdout at all.
- Two cheaper probes were measured and rejected: the youtube.com `ytcfg` blob (Deno's `fetch` is served
  a 37KB bot shell with no `ytcfg` at all, where curl gets 869KB) and youtubei.js `session.logged_in`
  (returns `true` for a junk cookie string — it reports that a cookie was supplied, not that YouTube
  took it).
- `ok: null` means the probe itself was inconclusive and is **never** reported as expired. Crying wolf
  about live cookies sends someone re-exporting for nothing.
- **`startCookieWatch()` re-checks every 6h** (`TIMEOUTS.COOKIE_CHECK_MS`), because the boot check alone
  misses what actually happened: the session rotated 20h into an uptime and nothing noticed until the
  next restart. It reports the **transition** only — a jar dead for a day must not file an issue every
  tick — and `logCookieHealth()` primes the baseline so a jar already dead at boot doesn't double-report.
  `shutdownStreams()` clears the interval.

**The cookie jar lives on the persistent mount, and `YOUTUBE_COOKIES` is a seed, not the authority.**
yt-dlp rewrites the jar on every exit because YouTube rotates session tokens as they are used — that
refresh *is* how a session stays alive. The jar used to sit in `/tmp`, so every deploy discarded the
rotated tokens and re-seeded from the config var, replaying a stale snapshot, which is what makes YouTube
invalidate a session. Suspected cause of cookies "expiring" every few days.
- It now lives in **`/data/ytdlp-cache/yt-cookies.txt`** — the Dokku bind mount. Note `/data` *itself* is
  container-local (its mtime is the container start time); only `/data/ytdlp-cache` survives a release.
  No mount (local dev) falls back to `/tmp`, which still keeps rotation for the container's life.
- `_seedCookies` writes the config var **only when its djb2 digest differs from `.cookie-seed`** next to
  the jar. Unchanged var + existing jar → keep the jar, it may carry rotated tokens the var doesn't have.
  Changed var → the operator re-exported, so it wins.
- `/setcookies` deliberately does **not** update the seed marker: it still records the config var, so the
  next boot sees an unchanged var and keeps the upload instead of reverting to the var's older value.
  An upload now survives restarts — still set the config var too, so a fresh volume has it.

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
