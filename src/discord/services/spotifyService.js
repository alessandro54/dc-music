import { LIMITS } from "@/lib/constants.js";

// Spotify Web API client — tokens and endpoints, nothing about /play. Turning a
// URL into songs is the resolver's job (resolvers/spotify.js).

const spotifyToken = {
    value: null,
    expiry: 0,
    async get() {
        if (this.value && Date.now() < this.expiry) return this.value;
        const res = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${
                    btoa(`${Deno.env.get("SPOTIFY_CLIENT_ID")}:${Deno.env.get("SPOTIFY_CLIENT_SECRET")}`)
                }`,
            },
            body: "grant_type=client_credentials",
        });
        const data = await res.json();
        if (!data.access_token) {
            throw new Error(`Spotify token error: ${JSON.stringify(data)}`);
        }
        this.value = data.access_token;
        this.expiry = Date.now() + (data.expires_in - 60) * 1000;
        return this.value;
    },
};

// Playlist track content requires a user-authorized token — Spotify's Client
// Credentials flow (used for tracks/albums below) can no longer read it.
// Refresh token comes from a one-time login: `deno task spotify-auth`.
const spotifyUserToken = {
    value: null,
    expiry: 0,
    async get() {
        if (this.value && Date.now() < this.expiry) return this.value;
        const refreshToken = Deno.env.get("SPOTIFY_REFRESH_TOKEN");
        if (!refreshToken) {
            throw new Error(
                "SPOTIFY_REFRESH_TOKEN not set — playlists need a user-authorized token. Run `deno task spotify-auth`.",
            );
        }
        const res = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${
                    btoa(`${Deno.env.get("SPOTIFY_CLIENT_ID")}:${Deno.env.get("SPOTIFY_CLIENT_SECRET")}`)
                }`,
            },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
        });
        const data = await res.json();
        if (!data.access_token) {
            throw new Error(`Spotify refresh error: ${JSON.stringify(data)}`);
        }
        this.value = data.access_token;
        this.expiry = Date.now() + (data.expires_in - 60) * 1000;
        return this.value;
    },
};

async function spotifyFetch(path, { userAuth = false } = {}) {
    const token = await (userAuth ? spotifyUserToken.get() : spotifyToken.get());
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.error) {
        throw new Error(
            `Spotify API error (${data.error.status ?? res.status}): ${data.error.message ?? "unknown"}`,
        );
    }
    return data;
}

// Fetch the client-credentials token now, so the first real call doesn't pay for
// it. Measured: an artwork lookup that also has to mint a token takes ~2.1s,
// which overruns /play's 2s acknowledge budget and costs the user an extra
// round-trip on the first play after every restart.
export const warmToken = () => spotifyToken.get();

export const getTrack = (id) => spotifyFetch(`/tracks/${id}`);

// Playlist name/art is public catalog data, so client-credentials is enough here.
export const getPlaylistMeta = (id) => spotifyFetch(`/playlists/${id}?fields=name`);

// The track listing needs a user-authorized token, and even then only for
// playlists Spotify considers this app authorized to read (in practice:
// playlists owned by the account behind the refresh token — Development Mode
// blocks reading other users' playlists, which surfaces as a 403).
export const getPlaylistItems = (id, limit = LIMITS.PLAYLIST_MAX) =>
    spotifyFetch(
        `/playlists/${id}/items?limit=${limit}&fields=items(item(name,duration_ms,artists,album(images),track))`,
        { userAuth: true },
    );

export const getAlbum = (id) => spotifyFetch(`/albums/${id}?fields=name,images`);

export const getAlbumTracks = (id, limit = 50) => spotifyFetch(`/albums/${id}/tracks?limit=${limit}`);

// Text search. Used to find album art for tracks that came from YouTube, where
// the only artwork available is a letterboxed video thumbnail.
export const searchTrack = (query, limit = 1) =>
    spotifyFetch(`/search?${new URLSearchParams({ q: query, type: "track", limit: String(limit) })}`);
