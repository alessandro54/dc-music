import { LIMITS } from "../../lib/constants.js";
import { isSpotifyUrl, resolveSpotify } from "./spotify.js";
import { backfillDuration, fetchPlaylistItems, fetchVideoInfo, searchVideo } from "./stream.js";

const YOUTUBE_RE = /(?:youtube\.com|youtu\.be)/;
const YOUTUBE_LIST_RE = /[?&]list=/;

const ytSong = (info, requestedBy, requestedById) => ({
    title: info.title,
    url: info.url,
    duration: info.duration,
    thumbnail: info.thumbnail ?? null,
    requestedBy,
    requestedById,
    spotifyTrack: null,
});

// Resolve a /play query (Spotify URL, YouTube URL/playlist, or search text)
// into a uniform { songs, playlistName }. Throws on empty/invalid input.
export async function resolveQuery(query, requestedBy, requestedById) {
    if (isSpotifyUrl(query)) {
        return resolveSpotify(query, requestedBy, requestedById);
    }

    if (YOUTUBE_RE.test(query) && YOUTUBE_LIST_RE.test(query)) {
        const items = await fetchPlaylistItems(query, LIMITS.PLAYLIST_MAX);
        if (!items.length) throw new Error("Playlist not found or empty");
        return {
            songs: items.map((v) => ({ ...v, requestedBy, requestedById, spotifyTrack: null })),
            playlistName: null,
        };
    }

    if (YOUTUBE_RE.test(query)) {
        const song = ytSong(await fetchVideoInfo(query), requestedBy, requestedById);
        // The fast metadata paths (oEmbed / gated Innertube) have no duration.
        // Ask yt-dlp for it in the background rather than making the user wait
        // seconds for a number that only decorates the embed.
        if (!song.duration) void backfillDuration(song);
        return { songs: [song], playlistName: null };
    }

    return { songs: [ytSong(await searchVideo(query), requestedBy, requestedById)], playlistName: null };
}
