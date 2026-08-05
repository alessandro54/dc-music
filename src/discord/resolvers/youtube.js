import { LIMITS } from "@/lib/constants.js";
import { searchVideo } from "@/discord/services/innertubeService.js";
import { backfillDuration, fetchPlaylistItems, fetchVideoInfo } from "@/discord/services/metadataService.js";

const URL_RE = /(?:youtube\.com|youtu\.be)/;
const LIST_RE = /[?&]list=/;

const song = (info, requestedBy, requestedById) => ({
    title: info.title,
    url: info.url,
    duration: info.duration,
    thumbnail: info.thumbnail ?? null,
    requestedBy,
    requestedById,
    spotifyTrack: null,
});

export default {
    name: "youtube",
    matches: (query) => URL_RE.test(query),

    async resolve(query, requestedBy, requestedById) {
        if (LIST_RE.test(query)) {
            const items = await fetchPlaylistItems(query, LIMITS.PLAYLIST_MAX);
            if (!items.length) throw new Error("Playlist not found or empty");
            return {
                songs: items.map((v) => ({ ...v, requestedBy, requestedById, spotifyTrack: null })),
                playlistName: null,
            };
        }

        const track = song(await fetchVideoInfo(query), requestedBy, requestedById);
        // The fast metadata paths (oEmbed / gated Innertube) have no duration.
        // Ask yt-dlp for it in the background rather than making the user wait
        // seconds for a number that only decorates the embed.
        if (!track.duration) void backfillDuration(track);
        return { songs: [track], playlistName: null };
    },

    // Plain text falls through to here — YouTube search is the default source.
    async search(query, requestedBy, requestedById) {
        return {
            songs: [song(await searchVideo(query), requestedBy, requestedById)],
            playlistName: null,
        };
    },
};
