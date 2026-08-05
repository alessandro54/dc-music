import { LIMITS } from "@/lib/constants.js";
import { formatMs } from "@/lib/utils.js";
import {
    getAlbum,
    getAlbumTracks,
    getPlaylistItems,
    getPlaylistMeta,
    getTrack,
} from "@/discord/services/spotifyService.js";

// Spotify injects an optional locale segment (e.g. /intl-es/) before the type.
const TRACK_RE = /open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]+)/;
const PLAYLIST_RE = /open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]+)/;
const ALBUM_RE = /open\.spotify\.com\/(?:intl-[a-z]+\/)?album\/([A-Za-z0-9]+)/;

// Spotify gives us no playable audio, so a song carries `spotifyTrack` and
// GuildQueue._playNext searches YouTube for it at play time, not queue time —
// which is why `url` stays null here.
function trackToSong(track, requestedBy, requestedById, art) {
    return {
        title: `${track.name} — ${track.artists[0].name}`,
        url: null,
        duration: formatMs(track.duration_ms),
        // Spotify album cover — kept through the YouTube resolution in _playNext.
        thumbnail: art ?? track.album?.images?.[0]?.url ?? null,
        requestedBy,
        requestedById,
        spotifyTrack: { name: track.name, artists: track.artists },
    };
}

export default {
    name: "spotify",
    matches: (query) => TRACK_RE.test(query) || PLAYLIST_RE.test(query) || ALBUM_RE.test(query),

    async resolve(query, requestedBy, requestedById) {
        const trackMatch = query.match(TRACK_RE);
        if (trackMatch) {
            const track = await getTrack(trackMatch[1]);
            return { songs: [trackToSong(track, requestedBy, requestedById)], playlistName: null };
        }

        const playlistMatch = query.match(PLAYLIST_RE);
        if (playlistMatch) {
            const meta = await getPlaylistMeta(playlistMatch[1]);
            let items;
            try {
                items = await getPlaylistItems(playlistMatch[1]);
            } catch (err) {
                // Translated here rather than in the client: the advice is about
                // what to try in /play, which the API client has no business
                // knowing about.
                if (err.message.includes("403")) {
                    throw new Error(
                        "Can't read this playlist — Spotify only allows this bot to read playlists owned by its connected account. Try a track or album link, or a YouTube playlist instead.",
                    );
                }
                throw err;
            }
            const songs = items.items
                .filter((i) => i.item?.track)
                .map((i) => ({ ...trackToSong(i.item, requestedBy, requestedById), viaPlaylist: true }));
            return { songs, playlistName: meta.name };
        }

        const albumMatch = query.match(ALBUM_RE);
        if (albumMatch) {
            const [tracks, album] = await Promise.all([
                getAlbumTracks(albumMatch[1]),
                getAlbum(albumMatch[1]),
            ]);
            // Album-track objects carry no album field — use the album's own cover.
            const art = album.images?.[0]?.url;
            const songs = tracks.items
                .slice(0, LIMITS.PLAYLIST_MAX)
                .map((t) => ({ ...trackToSong(t, requestedBy, requestedById, art), viaPlaylist: true }));
            return { songs, playlistName: album.name };
        }

        throw new Error("Unsupported Spotify URL");
    },
};

// Title + duration for one track, for the /play autocomplete label. Null for
// playlist/album URLs — they have no single track to describe.
export async function trackMeta(url) {
    const match = url.match(TRACK_RE);
    if (!match) return null;
    const track = await getTrack(match[1]);
    return {
        title: `${track.name} — ${track.artists[0].name}`,
        duration: formatMs(track.duration_ms),
    };
}
