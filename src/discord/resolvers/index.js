import soundcloud from "@/discord/resolvers/soundcloud.js";
import spotify from "@/discord/resolvers/spotify.js";
import youtube from "@/discord/resolvers/youtube.js";

// One resolver per source. Each exports `matches(query)` and
// `resolve(query, requestedBy, requestedById)` returning the uniform
// { songs, playlistName }. Order matters only for overlapping patterns —
// these three are disjoint.
const RESOLVERS = [spotify, youtube, soundcloud];

// Resolve a /play query (a URL from any supported source, or search text) into
// { songs, playlistName }. Throws on empty/invalid input.
export async function resolveQuery(query, requestedBy, requestedById) {
    const resolver = RESOLVERS.find((r) => r.matches(query));
    if (resolver) {
        return stampSource(await resolver.resolve(query, requestedBy, requestedById), resolver.name);
    }

    // No URL matched: treat it as search text. YouTube owns search because it is
    // the only source here with a usable search API on this IP.
    return stampSource(await youtube.search(query, requestedBy, requestedById), youtube.name);
}

// Record which resolver served the request, taken from the resolver's own name so
// a new source is labelled without touching this. It is *provenance*: a Spotify
// request stays "spotify" even though _playNext resolves it to a YouTube video to
// play, which is why it can't be read back off the url later.
function stampSource(result, source) {
    return { ...result, songs: result.songs.map((song) => ({ ...song, source })) };
}

export { RESOLVERS };
