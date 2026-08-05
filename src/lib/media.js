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

// One video reached three ways (pasted youtu.be link, watch?v= with a &t=,
// picked from search) produced three different URL strings, which split one song
// into three rows in anything grouped by url. Canonicalise so a video has one
// identity everywhere: history, the queue's duplicate check, the metadata cache.
export function canonicalUrl(url) {
    const id = extractVideoId(url);
    if (id) return `https://www.youtube.com/watch?v=${id}`;
    // Non-YouTube: keep the path (that *is* the identity on SoundCloud) and drop
    // only share/tracking noise, never parameters that might select content.
    try {
        const u = new URL(url);
        u.hash = "";
        for (const key of [...u.searchParams.keys()]) {
            if (key === "si" || key.startsWith("utm_")) u.searchParams.delete(key);
        }
        return u.toString().replace(/\/$/, "");
    } catch {
        return url; // not a URL (search text) — leave it alone
    }
}

// A track's stable identity, stored on every history row so the database can
// group plays without caring which URL form was pasted. Deliberately
// deterministic — no fuzzy matching — because it is persisted: a rule that
// changes later would need every existing row rewritten.
//
//   yt:<id>            YouTube, whatever the URL looked like
//   <canonical url>    anything else (SoundCloud's path *is* its identity)
//
// Merging separate *uploads* of one song is a different, heuristic problem —
// that stays at read time (see normalizeTitle) where the rule can improve
// without a migration.
export function trackFingerprint(url) {
    const id = extractVideoId(url);
    return id ? `yt:${id}` : canonicalUrl(url);
}

// Titles only, for grouping *different uploads* of the same song on a
// leaderboard. Strips packaging noise, deliberately NOT qualifiers that mean a
// different recording — live, remix, acoustic, cover, instrumental and version
// numbers all survive, because merging those would be wrong.
const TITLE_NOISE =
    /\s*[([]\s*(?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric\s*video)?|lyrics?(?:\s*video)?|hd|hq|4k|full\s*hd|audio|visualizer|mv|m\/v)\s*[)\]]/gi;

export function normalizeTitle(title) {
    return String(title ?? "")
        .replace(TITLE_NOISE, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

export function fmtSecs(s) {
    s = Math.floor(s);
    const m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h > 0
        ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
        : `${m}:${String(s % 60).padStart(2, "0")}`;
}
