import { LIMITS } from "@/lib/constants.js";
import { fetchPlaylistItems, fetchTrackInfo } from "@/discord/services/metadataService.js";

const URL_RE = /^https?:\/\/(?:www\.|m\.)?(?:soundcloud\.com|snd\.sc)\//i;
// /sets/ is SoundCloud's playlist/album URL form.
const SET_RE = /\/sets\//i;

const song = (info, requestedBy, requestedById) => ({
    title: info.title,
    url: info.url,
    duration: info.duration,
    thumbnail: info.thumbnail ?? null,
    requestedBy,
    requestedById,
    spotifyTrack: null,
    // SoundCloud serves m4a/AAC over HLS (measured), not webm/opus, so the audio
    // has to go through ffmpeg. Declared here so streamService needs no per-source
    // special case — see createStream.
    transcode: true,
});

// yt-dlp handles SoundCloud natively, so resolving is the same shape as YouTube.
// The difference is downstream, and it travels with the song: `transcode: true`.
export default {
    name: "soundcloud",
    matches: (query) => URL_RE.test(query),

    async resolve(query, requestedBy, requestedById) {
        if (SET_RE.test(query)) {
            const items = await fetchPlaylistItems(query, LIMITS.PLAYLIST_MAX);
            if (!items.length) throw new Error("SoundCloud set not found or empty");
            return {
                songs: items.map((v) => ({
                    ...v,
                    requestedBy,
                    requestedById,
                    spotifyTrack: null,
                    transcode: true,
                })),
                playlistName: null,
            };
        }

        return {
            songs: [song(await fetchTrackInfo(query), requestedBy, requestedById)],
            playlistName: null,
        };
    },
};
