import { embed } from "@/discord/views/embeds.js";
import { COLORS, LIMITS } from "@/lib/constants.js";

// The Now Playing / Added to Queue views are NOT here — they are Components V2
// containers, not embeds, and live in views/nowPlaying.js.

// /radio — names the seed and says the station is endless. A station whose seed
// is invisible is indistinguishable from a random shuffle, and the first question
// anyone asks of a radio is what it is a radio *of*. Saying it keeps going matters
// too: without that line an empty-looking queue reads as the bot having stopped.
export function radioQueued(count, seed, requestedBy) {
    return embed(COLORS.PRIMARY)
        .setTitle("📡 Radio Started")
        .setDescription(
            `Station seeded from **${seed.title}**\n${count} ${
                count === 1 ? "track" : "tracks"
            } queued — more will be added automatically.`,
        )
        .addFields(
            { name: "Requested by", value: requestedBy, inline: true },
            { name: "To stop", value: "`/stop` or ⏹️", inline: true },
        );
}

// Multiple tracks (Spotify/YouTube playlist or album) queued at once.
export function playlistQueued(count, playlistName, requestedBy, next = false) {
    return embed(COLORS.SPOTIFY)
        .setTitle(next ? "⏭️ Playlist Queued Next" : "📋 Playlist Queued")
        .setDescription(`**${playlistName ?? "Playlist"}** — ${count} songs added`)
        .addFields({ name: "Requested by", value: requestedBy, inline: true });
}

// /queue — list of upcoming tracks, capped at LIMITS.QUEUE_DISPLAY.
export function queueEmbed(queue) {
    const { songs } = queue;
    const lines = songs
        .slice(0, LIMITS.QUEUE_DISPLAY)
        .map((s, i) =>
            `${i === 0 ? "▶️" : `\`${i}.\``} **${s.title}** \`${s.duration ?? "—"}\` — ${s.requestedBy}`
        )
        .join("\n");
    const more = songs.length > LIMITS.QUEUE_DISPLAY
        ? `\n\n*...and ${songs.length - LIMITS.QUEUE_DISPLAY} more*`
        : "";

    return embed()
        .setTitle(`🎵 Queue — ${songs.length} song${songs.length !== 1 ? "s" : ""}`)
        .setDescription(lines + more);
}

// Most-played tracks. `plays` comes from the DB as a count, `duration` may be
// null for anything queued by URL before its duration was known.
const MEDALS = ["🥇", "🥈", "🥉"];

const rankOf = (i) => MEDALS[i] ?? `\`${i + 1}.\``;

// One embed, two sections: who picked the music, then what got played. DJs lead —
// the people are the draw, the tracklist is the evidence. `djs` may be empty on a
// server whose history predates the user_id column, in which case the section is
// dropped rather than rendered blank (an empty field value throws).
export function leaderboardEmbed(songs, djs = []) {
    const songLines = songs
        .map((s, i) => {
            const plays = `${s.plays} play${s.plays !== 1 ? "s" : ""}`;
            return `${rankOf(i)} **[${s.title}](${s.url})** \`${s.duration ?? "—"}\` — ${plays}`;
        })
        .join("\n");

    const e = embed().setTitle("🏆 Server Leaderboard");
    if (djs.length) e.addFields({ name: "🎧 Top DJs", value: djLines(djs) });
    e.addFields({ name: "🎵 Most Played", value: songLines });
    return e;
}

// A DJ's score is distinct songs they chose — see getTopDjs for why picks-only and
// why deduped. Rendered as a mention: it survives a rename, and mentions inside an
// embed don't ping. userTag is the fallback for a row written before tags, or a
// member who has since left the server.
function djLines(djs) {
    return djs
        .map((d, i) => {
            const who = d.userId ? `<@${d.userId}>` : (d.userTag ?? "unknown");
            const songs = `${d.songs} song${d.songs !== 1 ? "s" : ""}`;
            return `${rankOf(i)} ${who} — ${songs}`;
        })
        .join("\n");
}
