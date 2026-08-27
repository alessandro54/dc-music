import { findAlbumArt } from "@/discord/services/artworkService.js";
import { searchVideo } from "@/discord/services/innertubeService.js";
import { backfillDuration, fetchPlaylistItems, fetchVideoInfo } from "@/discord/services/metadataService.js";
import { LIMITS } from "@/lib/constants.js";
import { canonicalUrl, extractVideoId, ytThumb } from "@/lib/media.js";

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
        const url = canonicalUrl(query);
        // The song is enqueueable from the URL alone — everything else is
        // decoration the views already tolerate missing. So the metadata race
        // rides on the song (same lazy-hydrate idea as spotifyTrack) instead of
        // holding the reply: a picked suggestion resolves from the primed cache
        // inside the grace period, a pasted URL usually lands oEmbed (~37ms),
        // and the true tail — all fast sources failing over to a yt-dlp dump,
        // up to 20s — no longer holds /play open at all. GuildQueue applies
        // whatever lands late; the live panel redraws itself.
        const track = song(
            {
                title: `youtu.be/${extractVideoId(url) ?? "…"}`,
                url,
                duration: null,
                thumbnail: extractVideoId(url) ? ytThumb(extractVideoId(url)) : null,
            },
            requestedBy,
            requestedById,
        );
        track._meta = fetchVideoInfo(url).then((info) => {
            // The fast sources may land without a duration (oEmbed never has
            // one). The sidecar covers the track once it plays; the backfill
            // covers one that waits in the queue.
            if (!info.duration) void backfillDuration(track);
            return info;
        }).catch(() => null);

        const landed = await Promise.race([track._meta, sleep(META_GRACE_MS).then(() => null)]);
        if (landed) {
            track.title = landed.title;
            track.duration = landed.duration;
        }
        withAlbumArt(track);
        return { songs: [track], playlistName: null };
    },

    // Plain text falls through to here — YouTube search is the default source.
    async search(query, requestedBy, requestedById) {
        const track = song(await searchVideo(query), requestedBy, requestedById);
        withAlbumArt(track);
        return { songs: [track], playlistName: null };
    },
};

// Swap the letterboxed YouTube thumbnail for square album art when Spotify knows
// the track. NOT awaited any more: the lookup (warm 400-670ms, deadline 1200ms)
// was the last thing standing between Enter and the reply once metadata started
// coming from the primed cache. The song carries the pending lookup instead and
// GuildQueue._start applies it — which the live panel makes safe: art resolves
// in ~0.5s while the stream takes ~7s to first audio, so by the time the panel
// first renders the track, the square cover has long since landed. The only
// surface that can still show the letterboxed thumbnail is the one-shot "Added
// to Queue" card, sent before the lookup returns.
//
// The promise resolves to the art URL rather than mutating `track` itself:
// stampSource *copies* songs on the way to the queue, so a mutation here would
// hit an object the queue never sees. The holder of the queued copy applies it.
// Only for single tracks: a 100-item playlist would mean 100 lookups.
function withAlbumArt(track) {
    // A URL still waiting on its metadata has only a placeholder title, which
    // Spotify cannot match — chain the lookup on the title instead. For a song
    // whose title is already real, `_meta` is either absent or settled, so this
    // costs nothing.
    const titled = track._meta
        ? track._meta.then((info) => info?.title ?? track.title)
        : Promise.resolve(track.title);
    track._artwork = titled.then((title) => findAlbumArt(title)).catch(() => null);
}

// How long a /play reply will wait for metadata before answering with the
// placeholder. Long enough for the primed cache (0ms) and a healthy oEmbed
// (~37ms), short enough to be imperceptible when everything misses.
const META_GRACE_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
