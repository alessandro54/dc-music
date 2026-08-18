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
    PLAYED_HISTORY: 25, // per-guild in-memory undo stack behind /previous
};

export const TIMEOUTS = {
    QUEUE_IDLE_MS: 300_000, // stay in the channel this long after the queue empties
    ALONE_LEAVE_MS: 120_000, // leave once the last human has been gone this long
    VOICE_RECONNECT_MS: 5_000,
    STREAM_STALL_MS: 25_000, // skip if a track stays buffering this long (yt-dlp stalled)
    COOKIE_CHECK_MS: 21_600_000, // re-check the YouTube session every 6h — it rotates mid-uptime
};

export const POLL_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
