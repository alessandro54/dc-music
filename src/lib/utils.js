export function formatMs(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) {
        return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }
    return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Parse "m:ss", "h:mm:ss", or plain seconds string → seconds */
export function parseTimestamp(input) {
    const parts = input.split(":").map(Number);
    if (parts.some(Number.isNaN)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

/** Parse duration string "m:ss" or "h:mm:ss" → milliseconds */
export function durationToMs(ts) {
    if (!ts || ts === "Unknown") return null;
    const secs = parseTimestamp(ts);
    return secs !== null ? secs * 1000 : null;
}
