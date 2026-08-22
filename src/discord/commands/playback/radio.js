import { ensureVoice } from "@/discord/guards.js";
import { defineCommand } from "@/discord/router.js";
import { enqueue, getOrCreateQueue } from "@/discord/services/playbackService.js";
import { radioFrom } from "@/discord/services/radioService.js";
import { getRecentSongs } from "@/discord/services/trackService.js";
import { playlistQueued } from "@/discord/views/musicEmbeds.js";
import { LIMITS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";
import { extractVideoId } from "@/lib/media.js";

export default defineCommand({
    name: "radio",
    description: "Queue tracks similar to what this server has been playing",
    options: (b) =>
        b.addIntegerOption((o) =>
            o
                .setName("count")
                .setDescription(`How many tracks (default ${LIMITS.RADIO_TRACKS})`)
                .setMinValue(1)
                .setMaxValue(LIMITS.RADIO_MAX)
        ),
    guard: ensureVoice,
    handler: async (interaction, voiceChannel) => {
        const count = interaction.options.getInteger("count") ?? LIMITS.RADIO_TRACKS;
        // A Turso round-trip plus the automix calls runs past the 3s interaction
        // deadline often enough that /play's fast-path race isn't worth copying
        // here — /radio is not the hot path, so it just defers.
        await interaction.deferReply();
        const started = performance.now();

        // One pull serves both roles: the newest few are the seeds, the whole
        // window is the exclusion list so radio can't hand back a song the
        // server just heard.
        const recent = await getRecentSongs(interaction.guildId, LIMITS.RADIO_HISTORY_WINDOW);
        const withIds = recent
            .map((row) => ({ id: extractVideoId(row.url ?? ""), title: row.title }))
            .filter((row) => row.id);

        if (!withIds.length) {
            // Plain content, not `ephemeral()`: the reply was already deferred
            // publicly and Discord ignores the flag on an editReply, so wrapping it
            // would only claim a privacy this cannot have.
            return interaction.editReply("No YouTube history to seed from yet — play a few songs first.");
        }

        const queue = getOrCreateQueue(interaction, voiceChannel);
        const exclude = new Set([
            ...withIds.map((row) => row.id),
            // Anything already waiting: enqueue only dedups single tracks, and a
            // radio batch takes the `many` branch.
            ...queue.songs.map((song) => extractVideoId(song.url ?? "")).filter(Boolean),
        ]);

        const tracks = await radioFrom(withIds.slice(0, LIMITS.RADIO_SEEDS), { limit: count, exclude });
        if (!tracks.length) {
            return interaction.editReply("Couldn't find anything to play — YouTube returned no suggestions.");
        }

        const songs = tracks.map(({ id: _id, ...track }) => ({
            ...track,
            requestedBy: interaction.user.tag,
            requestedById: interaction.user.id,
            spotifyTrack: null,
            // Radio tracks are plays, not picks — same rule as a playlist. This is
            // what stops radio feeding on itself: they never become seeds, so the
            // station keeps drifting from what someone actually chose.
            viaPlaylist: true,
            source: "youtube",
        }));

        const result = enqueue(queue, songs, "📡 Radio");
        log.music(
            `Radio queued ${songs.length} ${
                log.gray(
                    `from ${withIds.slice(0, LIMITS.RADIO_SEEDS).length} seeds in ${
                        Math.round(performance.now() - started)
                    }ms`,
                )
            }`,
        );
        // A count of 1 takes enqueue's `single` branch, which has no playlist
        // embed — the message covers both rather than rendering two views.
        return interaction.editReply({
            embeds: [playlistQueued(result.count ?? 1, "📡 Radio", interaction.user.tag)],
        });
    },
});
