import { AudioPlayerStatus } from "@discordjs/voice";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import { embed } from "@/discord/views/embeds.js";
import { COLORS, LIMITS } from "@/lib/constants.js";
import { durationToMs, formatMs, progressBar } from "@/lib/utils.js";

// Single track added — "Now Playing" if it starts immediately, else "Added to Queue".
export function trackQueued(song, isFirst, position) {
    const e = embed()
        .setTitle(isFirst ? "🎵 Now Playing" : "➕ Added to Queue")
        .setDescription(`**${song.title}**`)
        .addFields(
            // duration can still be backfilling — an empty field value throws.
            { name: "Duration", value: song.duration ?? "—", inline: true },
            { name: "Requested by", value: song.requestedBy, inline: true },
            { name: "Position", value: isFirst ? "Now" : `#${position}`, inline: true },
        );
    if (song.thumbnail) e.setThumbnail(song.thumbnail);
    return e;
}

// Multiple tracks (Spotify/YouTube playlist or album) queued at once.
export function playlistQueued(count, playlistName, requestedBy) {
    return embed(COLORS.SPOTIFY)
        .setTitle("📋 Playlist Queued")
        .setDescription(`**${playlistName ?? "Playlist"}** — ${count} songs added`)
        .addFields({ name: "Requested by", value: requestedBy, inline: true });
}

// /np and the np:* buttons — current track with a progress bar.
export function nowPlayingEmbed(queue) {
    const song = queue.current;
    const elapsedMs = (queue.resource?.playbackDuration ?? 0) + queue.seekOffset * 1000;
    const totalMs = durationToMs(song.duration);

    const progressLine = totalMs
        ? `${progressBar(elapsedMs, totalMs)}\n\`${formatMs(elapsedMs)} / ${song.duration}\``
        : `\`${formatMs(elapsedMs)} elapsed\``;

    const e = embed()
        .setTitle("🎵 Now Playing")
        .setDescription(`**${song.title}**\n\n${progressLine}`)
        .addFields(
            { name: "Requested by", value: song.requestedBy, inline: true },
            { name: "Up next", value: queue.songs[1]?.title ?? "Nothing", inline: true },
        );
    if (song.thumbnail) e.setThumbnail(song.thumbnail);
    return e;
}

export function nowPlayingControls(queue) {
    const isPaused = queue.player.state.status === AudioPlayerStatus.Paused;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("np:pause").setEmoji(isPaused ? "▶️" : "⏸️").setStyle(
            ButtonStyle.Secondary,
        ),
        new ButtonBuilder().setCustomId("np:skip").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("np:stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
    );
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
