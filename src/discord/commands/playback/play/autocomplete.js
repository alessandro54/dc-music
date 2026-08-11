import { RESOLVERS } from "@/discord/resolvers/index.js";
import spotify, { trackMeta } from "@/discord/resolvers/spotify.js";
import { searchVideos } from "@/discord/services/innertubeService.js";
import { getRecentSongs } from "@/discord/services/trackService.js";
import { LIMITS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";

// Any URL a resolver claims is already playable as typed — suggesting search
// results for it would only get in the way. Spotify is handled separately
// below, because its metadata makes for a useful suggestion label.
const isResolvableUrl = (query) => RESOLVERS.some((r) => r !== spotify && r.matches(query));

export async function autocomplete(interaction) {
    const query = interaction.options.getFocused();
    const respond = (items = []) => interaction.respond(items).catch(() => {});

    if (query.length < 2) {
        const recent = await getRecentSongs(interaction.guildId, LIMITS.AUTOCOMPLETE_RESULTS);
        return respond(recent.map((s) => ({ name: s.title.slice(0, 100), value: s.url })));
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

        // Real YouTube video results via Innertube — value is the video URL
        // so the pick plays exactly that video (no re-search on submit).
        const videos = await Promise.race([searchVideos(query, LIMITS.AUTOCOMPLETE_RESULTS), deadline]);
        const items = videos.map((v) => ({
            name: `${v.title} · ${v.duration}`.slice(0, 100),
            value: v.url,
        }));
        // Fallback so the user can always submit their raw query as a search.
        if (!items.length) items.push({ name: `🔍 ${query}`.slice(0, 100), value: query });
        return respond(items);
    } catch (err) {
        if (err.message !== "timeout") log.error(`[autocomplete] ${err.message}`);
        const recent = await getRecentSongs(interaction.guildId, LIMITS.AUTOCOMPLETE_RESULTS);
        return respond(recent.map((s) => ({ name: `↩ ${s.title}`.slice(0, 100), value: s.url })));
    } finally {
        // Cancel the timer so a settled/early-return path can't leave the
        // deadline promise to reject later with no handler (unhandledRejection).
        clearTimeout(timer);
    }
}
