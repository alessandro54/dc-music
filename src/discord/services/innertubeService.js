import { Innertube } from "youtubei.js";

import { UserFacingError } from "@/lib/errors.js";
import { fmtSecs, ytThumb } from "@/lib/media.js";

// In-process YouTube client. Search is the only thing it is reliably good for on
// this IP — see metadataService for why getBasicInfo is a lucky fast path rather
// than the primary metadata source.

let _yt = null;

export async function getInnertube() {
    if (_yt) return _yt;
    _yt = await Innertube.create({ retrieve_player: false, generate_session_locally: true });
    return _yt;
}

export async function searchVideos(query, limit = 5) {
    const yt = await getInnertube();
    const results = await yt.search(query, { type: "video" });
    return (results.videos ?? []).slice(0, limit).map((video) => ({
        title: String(video.title?.text ?? video.title ?? query),
        url: `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration?.text ?? fmtSecs(video.duration?.seconds ?? 0),
        thumbnail: video.thumbnails?.[0]?.url ?? ytThumb(video.id),
    }));
}

export async function searchVideo(query) {
    const [first] = await searchVideos(query, 1);
    if (!first) throw new UserFacingError(`No results for **${query}**.`);
    return first;
}
