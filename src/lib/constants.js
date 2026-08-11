export const COLORS = {
    PRIMARY: 0x5865f2,
    SPOTIFY: 0x1db954,
};

export const LIMITS = {
    QUEUE_DISPLAY: 10,
    HISTORY: 10,
    PLAYLIST_MAX: 100,
    LEADERBOARD: 5,
    DJ_LEADERBOARD: 5,
    POLL_OPTIONS: 5,
    AUTOCOMPLETE_RESULTS: 5,
};

// Touched by the clientReady handler, polled by Dokku's startup healthcheck.
// /tmp is per-container, so a restarted container starts unready — which is the
// point: the file means "this process reached Discord", not "this app once did".
export const READY_FILE = "/tmp/bot-ready";

export const TIMEOUTS = {
    QUEUE_IDLE_MS: 30_000,
    VOICE_RECONNECT_MS: 5_000,
    STREAM_STALL_MS: 25_000, // skip if a track stays buffering this long (yt-dlp stalled)
};

export const POLL_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
