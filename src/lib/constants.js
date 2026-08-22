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
    RADIO_TRACKS: 10, // default /radio batch
    RADIO_MAX: 25,
    RADIO_SEEDS: 5, // newest picks used as automix seeds — fetched concurrently
    RADIO_HISTORY_WINDOW: 25, // pulled once: the newest few seed, all of them exclude
    RADIO_LOW_WATER: 3, // refill the station once the wait list drops to this
    RADIO_REFILL: 5, // tracks per refill — small, so the seed drifts often
    RADIO_MAX_FAILURES: 2, // consecutive empty refills before the station gives up
};

export const TIMEOUTS = {
    QUEUE_IDLE_MS: 300_000, // stay in the channel this long after the queue empties
    ALONE_LEAVE_MS: 120_000, // leave once the last human has been gone this long
    VOICE_RECONNECT_MS: 5_000,
    STREAM_STALL_MS: 25_000, // skip if a track stays buffering this long (yt-dlp stalled)
    COOKIE_CHECK_MS: 21_600_000, // re-check the YouTube session every 6h — it rotates mid-uptime
    RADIO_SEED_MS: 4_000, // per-seed automix budget; measured 740-950ms, so this is a hang guard
};

export const POLL_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
