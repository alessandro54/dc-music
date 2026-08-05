// Pure helpers for media URLs and durations — no I/O, no state, safe to import
// from anywhere. Extracted so ytdlpService, metadataService and streamService can
// share them without importing each other.

export function extractVideoId(url) {
    return url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
}

export function isYouTubeUrl(url) {
    return /(?:youtube\.com|youtu\.be)/.test(url);
}

// Derive a cover image from the video id — always exists, no extra API call.
// Only valid for YouTube ids: given a foreign id it invents a URL that 404s.
export function ytThumb(videoId) {
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
}

// Stable per-track filename component for the --print-to-file duration sidecar.
// YouTube has an 11-char id; other sources get their URL flattened.
export function trackKey(url) {
    return extractVideoId(url) ?? url.replace(/[^A-Za-z0-9_-]/g, "").slice(-40);
}

export function fmtSecs(s) {
    s = Math.floor(s);
    const m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0
        ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
        : `${m}:${String(s % 60).padStart(2, "0")}`;
}
