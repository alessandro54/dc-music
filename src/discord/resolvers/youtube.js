import { findAlbumArt } from "@/discord/services/artworkService.js";
import { searchVideo } from "@/discord/services/innertubeService.js";
import { backfillDuration, fetchPlaylistItems, fetchVideoInfo } from "@/discord/services/metadataService.js";
import { LIMITS } from "@/lib/constants.js";
import { canonicalUrl } from "@/lib/media.js";

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
                // viaPlaylist keeps these out of the "recently played" lists —
                // see db/schema.js.
                songs: items.map((v) => ({
                    ...v,
                    requestedBy,
                    requestedById,
                    spotifyTrack: null,
                    viaPlaylist: true,
                })),
                playlistName: null,
            };
        }

        // Canonicalise before anything stores it: youtu.be/X, watch?v=X&t=42 and
        // the search path's watch?v=X are one video and must share one identity.
        const track = song(await fetchVideoInfo(canonicalUrl(query)), requestedBy, requestedById);
        // The fast metadata paths (oEmbed / gated Innertube) have no duration.
        // Ask yt-dlp for it in the background rather than making the user wait
        // seconds for a number that only decorates the embed.
        if (!track.duration) void backfillDuration(track);
        await withAlbumArt(track);
        return { songs: [track], playlistName: null };
    },

    // Plain text falls through to here — YouTube search is the default source.
    async search(query, requestedBy, requestedById) {
        const track = song(await searchVideo(query), requestedBy, requestedById);
        await withAlbumArt(track);
        return { songs: [track], playlistName: null };
    },
};

// Swap the letterboxed YouTube thumbnail for square album art when Spotify knows
// the track. Awaited — it lands inside /play's 2s acknowledge budget, so the
// first embed already shows the right cover instead of correcting itself later.
// Only for single tracks: a 100-item playlist would mean 100 lookups.
async function withAlbumArt(track) {
    const art = await findAlbumArt(track.title);
    if (art) track.thumbnail = art;
}
