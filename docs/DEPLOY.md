# Deployment — Dokku on a VPS

CI/CD for the Discord music bot. Every push to `main` builds a Docker image,
pushes it to GitHub Container Registry (GHCR), then SSHes into a Dokku host and
redeploys via `git:from-image`.

```
push main ──► GitHub Actions ──► build image ──► push GHCR ──► ssh ──► dokku git:from-image
```

- **Repo:** `alessandro54/discord-music`
- **Image:** `ghcr.io/alessandro54/discord-music`
- **Dokku app:** `music-bot`
The bot is a Discord **gateway client**: all its real work is outbound. The only
thing it serves is `GET /health` on `:3000` for Dokku's deploy healthcheck
(`src/lib/health.js`) — no domain points at it and there is no reverse-proxy
config to keep working. (A control dashboard on the same port existed and was
removed; see "Removed: web dashboard" at the end.)

---

## Files in this repo

| File | Role |
|---|---|
| `.github/workflows/deploy.yml` | Build → push GHCR → ssh deploy |
| `Dockerfile` | Deno + ffmpeg + yt-dlp image (`EXPOSE 3000` for the healthcheck only) |
| `app.json` | Dokku `startup` healthcheck + `postdeploy` slash-command registration |

No build step — Deno runs `src/index.js` directly. Slash commands **are**
auto-registered on every deploy by the `postdeploy` hook in `app.json`; run
`deno task deploy` locally only to register them before they ship.

---

## One-time setup

Run on the machine indicated: **[local]** your laptop, **[server]** the Dokku
host (`ssh ubuntu@<server-ip>`), **[github]** the repo web UI.

### 1. Provision the Dokku host (skip if Dokku already installed)

On a fresh VPS (Ubuntu):

```bash
wget -NP . https://dokku.com/install/v0.38.19/bootstrap.sh
sudo DOKKU_TAG=v0.38.19 bash bootstrap.sh
```

Add your personal SSH key to the `dokku` user so you can manage it:

```bash
cat ~/.ssh/id_ed25519.pub | ssh root@<server-ip> "dokku ssh-keys:add admin"
```

### 2. Create the app + global proxy [server]

```bash
sudo dokku apps:create music-bot
```

The app listens on nothing, so it never touches ports 80/443 and cannot conflict
with anything else on the host (e.g. n8n).

### 3. Deploy SSH key for GitHub Actions

GitHub Actions needs a key to SSH into the host as `ubuntu`. Generate a
**dedicated** key (no passphrase — CI can't type one).

**[local]**

```bash
ssh-keygen -t ed25519 -C "gha-deploy" -f gha_deploy -N ""

# install the PUBLIC key on the server (use an existing working key to log in)
cat gha_deploy.pub | ssh -i ~/.ssh/<existing-key> ubuntu@<server-ip> \
  "cat >> ~/.ssh/authorized_keys"

# verify the new key works
ssh -i gha_deploy ubuntu@<server-ip> "echo ok"   # expect: ok
```

Copy the **raw private** key (the deploy uses `appleboy/ssh-action`, which wants
the unmodified PEM — multiple lines, no spaces, don't trim):

```bash
cat gha_deploy | pbcopy
```

**[github]** Repo → Settings → Secrets and variables → Actions. The deploy job
runs under `environment: production`, so add it as an **environment** secret
(Environments → `production`), not a plain repo secret — otherwise the job reads
it as empty:

| Secret | Value |
|---|---|
| `DOKKU_SSH_KEY` | full `-----BEGIN OPENSSH PRIVATE KEY-----` … `-----END-----` |

GHCR push uses the auto-provided `GITHUB_TOKEN` — no other secret needed.

Clean up **[local]**: `rm gha_deploy gha_deploy.pub`

The workflow consumes it directly:
```yaml
- uses: appleboy/ssh-action@v1
  with:
    host: <server-ip>
    username: ubuntu
    key: ${{ secrets.DOKKU_SSH_KEY }}
    script: sudo dokku git:from-image music-bot <image>:<sha>
```

### 4. Let `ubuntu` run dokku [server]

The workflow runs `sudo dokku ...`. Grant passwordless sudo for just that binary:

```bash
echo "ubuntu ALL=(ALL) NOPASSWD: $(which dokku)" | sudo tee /etc/sudoers.d/dokku-deploy
sudo chmod 440 /etc/sudoers.d/dokku-deploy
sudo dokku version   # must run without a password prompt
```

### 5. App config / secrets [server]

Stored on the host, injected at runtime — never baked into the image. Values
are write-only once set (you cannot read them back; keep them in a password
manager).

```bash
sudo dokku config:set music-bot \
  BOT_TOKEN=<discord bot token> \
  GUILD_ID=414892529427939338 \
  OWNER_ID=<discord user id> \
  TURSO_DATABASE_URL=libsql://<your-db>.turso.io \
  TURSO_AUTH_TOKEN=<full-access token> \
  SPOTIFY_CLIENT_ID=<value> \
  SPOTIFY_CLIENT_SECRET=<value> \
  SPOTIFY_REFRESH_TOKEN=<value> \
  SENTRY_DSN=<sentry dsn> \
  NODE_ENV=production
```

Notes:
- **`BOT_TOKEN` is required** — `src/index.js` logs in with `BOT_TOKEN` only
  (not `DISCORD_TOKEN`). If migrating from a platform that named it
  `DISCORD_TOKEN`, rename it here.
- **DB = Turso** (remote). `TURSO_DATABASE_URL` being set selects the Turso
  adapter; no `/data` volume or `DB_URL` needed. (For local SQLite instead,
  drop the Turso vars and mount a volume — see "SQLite alternative" below.)
- **`SENTRY_DSN`** — optional. When unset the SDK is a no-op (local dev stays
  quiet); when set, swallowed failures (stream drops, yt-dlp non-zero exits,
  command errors, DB writes) become issues in the `music-bot` project of the
  `alessandro54` Sentry org, tagged with `stage`, `guild`, `command` and
  released against the deployed commit SHA. The yt-dlp stderr tail rides along,
  so an expired `YOUTUBE_COOKIES` is self-diagnosing.
  Dev and prod share one project and are split by Sentry **environment**:
  `NODE_ENV=production` (set in the Dockerfile and in `dokku config:set`) →
  `production`, anything else → `development`. Filter with `environment:production`
  in the issue stream, and scope alerts to it so local runs never page you.
  `SENTRY_ENVIRONMENT` overrides the derived value if a third env ever appears.
- **`SPOTIFY_REFRESH_TOKEN`** — Spotify's Client Credentials flow
  (`SPOTIFY_CLIENT_ID`/`SECRET`) can read tracks and albums but no longer
  playlist contents (Spotify policy change). Playlist URLs need a
  user-authorized refresh token instead. Generate one locally:
  1. Add `http://127.0.0.1:8888/callback` as a Redirect URI on the app in the
     [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
  2. Run `deno task spotify-auth`, open the printed URL, approve access.
  3. Copy the printed `SPOTIFY_REFRESH_TOKEN` into `.env` (dev) and
     `dokku config:set` (prod).
  - **Limitation:** this app is in Spotify's Development Mode, which only
    lets it read playlists *owned by the account that authorized the
    token* — not arbitrary users' playlists (confirmed: 403, even on
    follow). `/play` surfaces a friendly error for other playlists rather
    than crashing. Track and album links are unaffected — those work for
    anyone via client-credentials.
- Optional: `YOUTUBE_COOKIES` (Netscape cookies if 403s become frequent).

### 6. Enable the zero-downtime health check [server]

Checks must be **enabled** for `app.json` to be honoured — with them disabled
Dokku skips the healthcheck entirely and prints *"Zero downtime is disabled,
stopping currently running containers"*, i.e. the bot goes down mid-track on
every release and nothing verifies the new one works.

```bash
sudo dokku checks:enable music-bot
```

> Historically this said `checks:disable`, because Dokku's default check would
> fail the first deploy. The `startup` check in `app.json` replaces it: Dokku
> polls `GET /health` on port 3000 (12 attempts × 5s), served by
> `src/lib/health.js` — one route, no auth, no dashboard. It returns 503 until
> the Discord client is ready, so the check waits for a real login rather than
> for the process to merely exist, and a bad `BOT_TOKEN` fails the release and
> leaves the old container serving.
>
> **Do not switch this to a `command` check.** `test -f /tmp/bot-ready` was tried
> and the `docker-local` scheduler never runs it: the deploy hung past the
> ssh-action's 600s timeout, and the orphaned Dokku process kept holding the app
> lock so every later `dokku` command hung until `sudo pkill -f "from-image
> music-bot"`. Recovery, if it ever happens again:
>
> ```bash
> sudo pkill -f "from-image music-bot"
> sudo docker rm -f music-bot.web.1.upcoming-<id>   # orphaned second instance
> sudo dokku checks:disable music-bot               # unblock deploys
> ```

### 7. First deploy + make image public

Push to `main` (or re-run the workflow). The **build-and-push** job succeeds and
creates the GHCR package; the **deploy** job fails the first time because the
package is still private and the host can't pull it.

**[github]** Profile → Packages → `discord-music` → Package settings →
Change visibility → **Public**. The host then pulls anonymously (no registry
login).

> Private alternative: keep the package private and run once on the host
> `dokku registry:login ghcr.io <user> <PAT-with-read:packages>`.

Then **[github]** Actions → the failed run → **Re-run failed jobs**. Deploy now
pulls the public image and runs `git:from-image`.

### 8. Domain + HTTPS [server] — no longer applicable

The bot serves no HTTP, so it needs no DNS record, no domain and no TLS
certificate. If `music.chumpitaz.dev` was pointed at this app for the old
dashboard, unset it on the host:

```bash
sudo dokku domains:clear music-bot
sudo dokku proxy:disable music-bot
```

---

## 9. YouTube access (PO-token provider + cookies + EJS)

This VPS's IP is a **datacenter IP** that YouTube hard-flags — every yt-dlp
client returns `LOGIN_REQUIRED`. Three pieces are needed together:

1. **Cookies** — get past the `LOGIN_REQUIRED` login gate (the only thing that does).
2. **PO-token provider** — supplies GVS PO tokens and refreshes the session (so
   cookies last far longer); runs as a Docker sidecar.
3. **EJS solver** — solves YouTube's signature / `n`-sig challenge, else only
   non-audio formats come back. Ships **in the image** as the `yt-dlp-ejs`
   package and is picked up automatically; it runs on the deno already present.

The image installs `yt-dlp[default]` + the `bgutil-ytdlp-pot-provider` **plugin**
via pip (not the standalone binary) so the plugin is auto-discovered. The
`[default]` group is what pulls `yt-dlp-ejs` (version-pinned to yt-dlp) plus the
requests/urllib3/websockets HTTP stack — bare `pip install yt-dlp` declares no
dependencies at all.

> Do **not** add `--remote-components ejs:github`. It is the alternative to the
> bundled package, not a companion: with the package installed, the flag still
> fetched the solver from GitHub (measured 9.08s cold vs 2.06s local). The
> container has no volume, so every deploy starts from a cold cache.

### PO-token provider sidecar [server]
```bash
sudo dokku network:create ytpot
sudo docker run --name bgutil-provider -d --init --restart unless-stopped \
  --network ytpot \
  brainicism/bgutil-ytdlp-pot-provider:1.3.1     # arm64 multi-arch; keep version == pip plugin pin
sudo dokku network:set music-bot attach-post-deploy ytpot   # bot joins the network on each deploy
sudo dokku config:set music-bot YTDLP_POT_BASE_URL=http://bgutil-provider:4416
```
The bot reaches the provider by container name over the shared `ytpot` network.
`streamService.js` adds `--extractor-args youtubepot-bgutilhttp:base_url=$YTDLP_POT_BASE_URL`
to every yt-dlp call when the var is set.

> The plugin pin in the Dockerfile (`bgutil-ytdlp-pot-provider==1.3.1`) **must
> match** the provider image tag. Bump both together.

### Cookies [local → server]
Export Netscape cookies from an **incognito** window logged into a throwaway
YouTube account — open one video, export with "Get cookies.txt LOCALLY", then
**close the window without browsing further** (stops YouTube rotating the
session token → cookies last much longer).
```bash
scp -i <key> cookies.txt ubuntu@<server-ip>:~/cookies.txt
sudo dokku config:set music-bot YOUTUBE_COOKIES="$(cat ~/cookies.txt)" && rm ~/cookies.txt
```

### Verify [server]
```bash
sudo dokku enter music-bot web /opt/ytdlp/bin/yt-dlp \
  --cookies /tmp/yt-cookies.txt \
  --extractor-args 'youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416' \
  --skip-download --print title \
  'https://www.youtube.com/watch?v=<id>'
```
Prints the title = the full chain works.

### Sidecars
`bgutil-provider` (PO tokens) and `warp` (clean egress IP) both run as plain
containers on the `ytpot` network. What each buys, with measurements, and the
failure modes: [`ARCHITECTURE.md`](ARCHITECTURE.md). For a from-scratch box the
whole topology is in [`docker-compose.yml`](../docker-compose.yml).

```bash
# PO-token provider — makes the no-cookie path reliable (3/4 → 12/12 videos)
sudo docker run -d --name bgutil-provider --restart=unless-stopped \
  --network ytpot brainicism/bgutil-ytdlp-pot-provider:1.3.1

# WARP SOCKS5 proxy — clean egress IP, which is what lets cookies be dropped
# (~6s per cold play). NET_ADMIN + the tun device rule are required.
sudo docker run -d --name warp --restart=unless-stopped --network ytpot \
  --cap-add NET_ADMIN --device-cgroup-rule='c 10:200 rwm' \
  --sysctl net.ipv6.conf.all.disable_ipv6=0 \
  --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  caomingjun/warp:latest

# point the bot at them
sudo dokku config:set music-bot \
  YTDLP_POT_BASE_URL=http://bgutil-provider:4416 \
  YTDLP_PROXY=socks5://warp:1080
```

Verify WARP is up and egressing elsewhere:
```bash
sudo docker exec music-bot.web.1 curl -s --socks5-hostname warp:1080 https://api.ipify.org
sudo docker exec music-bot.web.1 curl -s https://api.ipify.org   # should differ
```

Keep `YOUTUBE_COOKIES` set even once the proxy path no longer needs it — it is
the fallback when WARP is down.

### yt-dlp cache volume
`/data/ytdlp-cache` is bind-mounted so the player JS and signature caches survive
a redeploy (the container filesystem does not):
```bash
sudo dokku storage:mount music-bot \
  /var/lib/dokku/data/storage/music-bot-ytdlp-cache:/data/ytdlp-cache
```
Check with `dokku storage:list music-bot`. Takes effect on the next deploy.

### Staying alive indefinitely
- A **weekly scheduled CI rebuild** (Mon 06:00 UTC, `CACHEBUST` busts the pip
  layer) keeps yt-dlp + EJS current with YouTube changes — no manual step.
  The install uses `pip install -U --pre yt-dlp`, i.e. the **nightly** channel:
  YouTube extractor fixes ship there first and stable can trail by weeks (on
  2026-08-04 stable was `2026.07.04`, nightly `2026.07.23`), so stable-only was
  stale for precisely the breakage that takes playback down. Trade-off: a bad
  nightly can sit for up to a week — `workflow_dispatch` the workflow to rebuild
  on demand. Verify what's live with
  `sudo docker exec music-bot.web.1 yt-dlp --version`.
- The **only** recurring manual task is re-exporting cookies when they finally
  expire (you'll see `Sign in to confirm` in the logs). POT keeps that rare.
- Occasionally bump the provider image + Dockerfile plugin pin together.

---

## Everyday flow

- **Code change** → `git push origin main` → auto build + deploy. Done.
- **Slash command change** → run `deno task deploy` locally (needs `.env`),
  then push the code.
- **Secret change** → `sudo dokku config:set music-bot KEY=value` (triggers a restart).

---

## Verify / operate [server]

```bash
sudo dokku ps:report music-bot          # running state
sudo dokku logs music-bot --tail 100    # logs (look for the bot login line)
sudo dokku config:show music-bot        # current env
sudo dokku ps:restart music-bot         # restart
```

Rollback to a previous image (tags are `:<git-sha>`):
```bash
sudo dokku git:from-image music-bot ghcr.io/alessandro54/discord-music:<old-sha>
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `can't connect without a private SSH key` (appleboy) | `DOKKU_SSH_KEY` empty for the job. It's a **`production` environment** secret — the deploy job must declare `environment: production`. |
| `Load key: error in libcrypto` / `Permission denied (publickey)` | Private key mangled on paste. Store the **raw** key (`cat key \| pbcopy`), full `-----BEGIN…END-----`, no edits. |
| `no matching manifest for linux/arm64/v8` / `Failed to pull image` | Oracle Ampere VPS is **arm64**. Build `platforms: linux/arm64` (QEMU) and fetch `yt-dlp_linux_aarch64`. |
| Deploy job: `denied` / cannot pull image | GHCR package still private → make it public (step 7) or `dokku registry:login`. |
| `sudo: a password is required` in deploy | sudoers rule missing/wrong path (step 4). Check `which dokku` matches. |
| `TokenInvalid` / bot builds but never comes online | Wrong/missing `BOT_TOKEN` (must be `BOT_TOKEN`, not `DISCORD_TOKEN`; Reset in Discord Dev Portal, `dokku config:set music-bot BOT_TOKEN='…'`. |
| Deploy hangs then fails on health check | The bot never reached Discord within 12×5s — check `BOT_TOKEN` and `dokku logs music-bot`. The old container keeps serving, which is the point. |
| `Zero downtime is disabled` in the deploy log | Checks are off; `sudo dokku checks:enable music-bot` (step 6). The `app.json` healthcheck is ignored while disabled. |
| `Tini is not running as PID 1` warning | Harmless — yt-dlp reaping is explicit in `streamService.js`, not Tini-dependent. |
| OOM / bot dies mid-song | yt-dlp child not reaped — see memory notes in `CLAUDE.md`. Ensure VPS has enough RAM/swap. |

---

## SQLite alternative (instead of Turso)

If running SQLite locally on the host rather than Turso:

```bash
sudo dokku config:unset music-bot TURSO_DATABASE_URL TURSO_AUTH_TOKEN
sudo dokku config:set music-bot DB_URL=sqlite:/data/bot.db
sudo dokku storage:ensure-directory music-bot
sudo dokku storage:mount music-bot /var/lib/dokku/data/storage/music-bot:/data
sudo dokku ps:restart music-bot
```

The mount persists `/data/bot.db` across deploys.

---

## Removed: web dashboard

`src/lib/server.js` plus `dashboard.html` and `config.html` served an optional web
UI on `:3000` (live queue view over SSE, and skip/pause/stop controls gated by
`DASHBOARD_TOKEN`). It was removed: the bot is a gateway client, so an inbound
HTTP listener was the only reason it needed a port, a domain, a TLS cert and
proxy config, and `/np`'s buttons already cover the controls from inside Discord.

On the host, clean up what only existed for it:

```bash
sudo dokku config:unset music-bot DASHBOARD_TOKEN
sudo dokku domains:clear music-bot
sudo dokku proxy:disable music-bot
```

`src/lib/config.js` stayed — `/setup` and the welcome-message event use it.
