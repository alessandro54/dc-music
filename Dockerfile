# syntax=docker/dockerfile:1

FROM denoland/deno:debian
WORKDIR /app

# Stable layer — system packages + pokemon-colorscripts. Nothing here tracks
# YouTube, so it must stay above ARG CACHEBUST: putting the arg first made the
# weekly yt-dlp refresh reinstall ffmpeg/python and re-clone the sprites too
# (measured on arm64: 30.6s of needless work per scheduled build).
# git is only needed for the clone, so it's purged in the same layer (-120MB).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates git python3 python3-venv \
    && git clone --depth 1 https://gitlab.com/phoneybadger/pokemon-colorscripts.git /tmp/pokemon-colorscripts \
    && (cd /tmp/pokemon-colorscripts && sh install.sh) \
    && rm -rf /tmp/pokemon-colorscripts \
    && apt-get purge -y --auto-remove git \
    && rm -rf /var/lib/apt/lists/*

COPY deno.json deno.lock ./
RUN deno install --allow-scripts \
    && deno eval "import '@db/sqlite'" 2>/dev/null || true

# Volatile layer, deliberately last before the source copy — changing CACHEBUST
# (weekly scheduled builds pass github.run_id) invalidates this and nothing
# else, so a yt-dlp refresh costs ~2.2s instead of rebuilding deno deps too.
ARG CACHEBUST=

# yt-dlp via pip (not the standalone binary) so the bgutil PO-token provider
# plugin is auto-discovered — lets us bypass YouTube bot detection on datacenter
# IPs without cookies. Installed in a venv (Debian is PEP 668 externally-managed).
#
# --pre installs the nightly channel (PyPI .dev0 prereleases). YouTube extractor
# fixes land in nightly first and stable can trail it by weeks — on 2026-08-04
# stable was 2026.07.04 while nightly was 2026.07.23. bgutil stays on its pin,
# so --pre only affects yt-dlp.
#
# [default] (not bare yt-dlp) pulls the recommended dependency group: yt-dlp-ejs
# — the nsig/signature solver, pinned to the exact version this yt-dlp requires —
# plus the requests/urllib3/websockets/brotli HTTP stack. Bare `pip install
# yt-dlp` declares no dependencies at all, which left the image fetching the EJS
# solver from GitHub at runtime (--remote-components). That was a hard runtime
# dependency on GitHub for every cold container: no solver, no YouTube audio.
RUN python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir -U --pre "yt-dlp[default]" "bgutil-ytdlp-pot-provider==1.3.1" \
    && ln -s /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && /opt/ytdlp/bin/python -c "import yt_dlp_ejs"

COPY src/ ./src/

# Dokku reads app.json out of the deployed image (git:from-image), and its
# postdeploy hook is what registers the slash commands on every release. Without
# this COPY the hook simply never runs — which is how a new command could ship in
# the image and never appear in Discord.
COPY app.json ./

ENV NODE_ENV=production \
    YTDLP_PATH=/usr/local/bin/yt-dlp

# Readiness endpoint only (src/lib/health.js) — Dokku's deploy healthcheck polls
# it. Not the dashboard coming back; nothing else is served on this port.
EXPOSE 3000


CMD ["deno", "run", "--allow-all", "--cached-only", "src/index.js"]
