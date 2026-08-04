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
- **Dashboard:** `https://music.chumpitaz.dev` (optional web UI on port 3000)

The bot is a Discord **gateway client** — it does not need inbound HTTP to run.
The `:3000` HTTP server is only the optional control dashboard.

---

## Files in this repo

| File | Role |
|---|---|
| `.github/workflows/deploy.yml` | Build → push GHCR → ssh deploy |
| `Dockerfile` | Deno + ffmpeg + yt-dlp image; `EXPOSE 3000` |

No build step — Deno runs `src/index.js` directly. Slash commands are **not**
auto-registered on deploy (run `deno task deploy` locally when they change).

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

Dokku reuses one nginx for all apps and routes by hostname, so the bot's
dashboard coexists with any other app (e.g. n8n) on ports 80/443 — no conflict.

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
  CLIENT_ID=1513765585794895872 \
  GUILD_ID=414892529427939338 \
  OWNER_ID=<discord user id> \
  TURSO_DATABASE_URL=libsql://<your-db>.turso.io \
  TURSO_AUTH_TOKEN=<full-access token> \
  SPOTIFY_CLIENT_ID=<value> \
  SPOTIFY_CLIENT_SECRET=<value> \
  SPOTIFY_REFRESH_TOKEN=<value> \
  DASHBOARD_TOKEN=$(openssl rand -hex 24) \
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
- **`DASHBOARD_TOKEN`** protects the dashboard's control endpoints
  (skip/pause/stop). Required before exposing the dashboard publicly. Access it
  at `https://music.chumpitaz.dev/?token=<value>`.
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

### 6. Disable the zero-downtime health check [server]

The bot has no fast HTTP readiness on boot (Discord login takes a moment), so
Dokku's default check would fail the first deploy:

```bash
sudo dokku checks:disable music-bot
```

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

### 8. Domain + HTTPS [server]

After the app is running and DNS resolves:

**DNS** — add an `A` record: `music.chumpitaz.dev → <server-ip>`
(verify: `dig +short music.chumpitaz.dev`).

```bash
# letsencrypt plugin (once per host)
sudo dokku plugin:install https://github.com/dokku/dokku-letsencrypt.git

sudo dokku letsencrypt:set music-bot email you@chumpitaz.dev
sudo dokku domains:set music-bot music.chumpitaz.dev
sudo dokku letsencrypt:enable music-bot
sudo dokku letsencrypt:cron-job --add   # auto-renew
```

`EXPOSE 3000` in the Dockerfile tells Dokku to map proxy → container:3000 and
inject `PORT`. The bot reads `PORT` (falls back to 3000).

---

## 9. YouTube access (PO-token provider + cookies + EJS)

This VPS's IP is a **datacenter IP** that YouTube hard-flags — every yt-dlp
client returns `LOGIN_REQUIRED`. Three pieces are needed together:

1. **Cookies** — get past the `LOGIN_REQUIRED` login gate (the only thing that does).
2. **PO-token provider** — supplies GVS PO tokens and refreshes the session (so
   cookies last far longer); runs as a Docker sidecar.
3. **EJS solver** — solves YouTube's signature / `n`-sig challenge, else only
   non-audio formats come back. Enabled in code via `--remote-components ejs:github`.

The image installs yt-dlp + the `bgutil-ytdlp-pot-provider` **plugin** via pip
(not the standalone binary) so the plugin is auto-discovered.

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
`stream.js` adds `--extractor-args youtubepot-bgutilhttp:base_url=$YTDLP_POT_BASE_URL`
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
  --remote-components ejs:github --skip-download --print title \
  'https://www.youtube.com/watch?v=<id>'
```
Prints the title = the full chain works.

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
sudo dokku logs music-bot --tail 100    # logs (look for bot login + dashboard line)
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
| `TokenInvalid` / bot builds but never comes online | Wrong/missing `BOT_TOKEN` (must be `BOT_TOKEN`, not `DISCORD_TOKEN`; don't paste the `DASHBOARD_TOKEN` rand by mistake). Reset in Discord Dev Portal, `dokku config:set music-bot BOT_TOKEN='…'`. |
| First deploy fails on health check | `sudo dokku checks:disable music-bot` (step 6). |
| Dashboard reachable without auth | Set `DASHBOARD_TOKEN` and use `?token=...`. |
| `Tini is not running as PID 1` warning | Harmless — yt-dlp reaping is explicit in `stream.js`, not Tini-dependent. |
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
