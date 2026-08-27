import { RESOLVERS } from "@/discord/resolvers/index.js";
import spotify, { trackMeta } from "@/discord/resolvers/spotify.js";
import { peekSearch, peekSearchPrefix, searchVideos } from "@/discord/services/innertubeService.js";
import { primeVideoInfo } from "@/discord/services/metadataService.js";
import { getRecentSongs } from "@/discord/services/trackService.js";
import { LIMITS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";

// Any URL a resolver claims is already playable as typed — suggesting search
// results for it would only get in the way. Spotify is handled separately
// below, because its metadata makes for a useful suggestion label.
const isResolvableUrl = (query) => RESOLVERS.some((r) => r !== spotify && r.matches(query));

// Fallback entry so the user can always submit their raw query as a search.
// Priming here is what makes picking a suggestion instant: every result shown
// already carries title/duration/thumbnail, so the /play submit that follows
// resolves from memory instead of re-fetching what the user just looked at —
// and, since the duration comes with it, without the backfill yt-dlp spawn.
function suggestions(videos, query) {
    if (!videos.length) return [{ name: `🔍 ${query}`.slice(0, 100), value: query }];
    for (const v of videos) primeVideoInfo(v);
    return videos.map((v) => ({ name: `🎵 ${v.title} · ${v.duration}`.slice(0, 100), value: v.url }));
}

// /play's very first focus event fires with an empty query, so the recents ARE
// the "command opened" experience — and they were a Turso round-trip every
// keystroke under 2 chars. 30s of staleness is invisible (a song someone just
// played shows up next time), the RTT on open is not.
const RECENTS_TTL_MS = 30_000;
const recentsCache = new Map(); // guildId -> { at, rows }

async function recentSongs(guildId) {
    const hit = recentsCache.get(guildId);
    if (hit && Date.now() - hit.at < RECENTS_TTL_MS) return hit.rows;
    const rows = await getRecentSongs(guildId, LIMITS.AUTOCOMPLETE_RESULTS);
    recentsCache.set(guildId, { at: Date.now(), rows });
    return rows;
}

export async function autocomplete(interaction) {
    const query = interaction.options.getFocused();
    const respond = (items = []) => interaction.respond(items).catch(() => {});

    if (query.length < 2) {
        const recent = await recentSongs(interaction.guildId);
        return respond(recent.map((s) => ({ name: `🕘 ${s.title}`.slice(0, 100), value: s.url })));
    }

    let timer;
    const deadline = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), 2500);
    });

    try {
        if (spotify.matches(query)) {
            const meta = await Promise.race([trackMeta(query), deadline]);
            if (meta) {
                return respond([{ name: `${meta.title} (${meta.duration})`.slice(0, 100), value: query }]);
            }
            return respond([{ name: "Spotify playlist/album — press Enter to queue", value: query }]);
        }

        if (isResolvableUrl(query)) return respond([]);

        // An autocomplete gets exactly one response and a late one is thrown
        // away, so anything already in hand beats anything fetched. A cached
        // answer for this query is served without touching the network at all.
        const cached = peekSearch(query, LIMITS.AUTOCOMPLETE_SONGS);
        if (cached) return respond(suggestions(cached, query));

        // Nothing for this query yet, but the previous keystroke's results are
        // still a reasonable answer — typing forward narrows a result set rather
        // than replacing it. Show those *now* and fetch the exact query in the
        // background, so the next keystroke is an instant cache hit. This is what
        // turns a lookup that trails the typing by ~450ms per character into one
        // that keeps up.
        const stale = peekSearchPrefix(query, LIMITS.AUTOCOMPLETE_SONGS);
        if (stale) {
            void searchVideos(query, LIMITS.AUTOCOMPLETE_SONGS).catch(() => {});
            return respond(suggestions(stale, query));
        }

        // Real YouTube video results via Innertube — value is the video URL
        // so the pick plays exactly that video (no re-search on submit).
        const videos = await Promise.race([searchVideos(query, LIMITS.AUTOCOMPLETE_SONGS), deadline]);
        return respond(suggestions(videos, query));
    } catch (err) {
        if (err.message !== "timeout") log.error(`[autocomplete] ${err.message}`);
        const recent = await recentSongs(interaction.guildId);
        return respond(recent.map((s) => ({ name: `↩ ${s.title}`.slice(0, 100), value: s.url })));
    } finally {
        // Cancel the timer so a settled/early-return path can't leave the
        // deadline promise to reject later with no handler (unhandledRejection).
        clearTimeout(timer);
    }
}
