import { ensureVoice } from "@/discord/guards.js";
import { defineCommand } from "@/discord/router.js";
import { searchVideo } from "@/discord/services/innertubeService.js";
import { enqueue, getOrCreateQueue, queues } from "@/discord/services/playbackService.js";
import { radioFrom, radioSongs } from "@/discord/services/radioService.js";
import { getRecentSongs } from "@/discord/services/trackService.js";
import { radioQueued } from "@/discord/views/musicEmbeds.js";
import { LIMITS } from "@/lib/constants.js";
import { UserFacingError } from "@/lib/errors.js";
import { log } from "@/lib/logger.js";
import { extractVideoId, isYouTubeUrl } from "@/lib/media.js";

export default defineCommand({
    name: "radio",
    description: "Start an endless station from a song — keeps adding tracks until you stop it",
    options: (b) =>
        b
            .addStringOption((o) =>
                o
                    .setName("seed")
                    .setDescription(
                        "Song to build the station from (URL or search). Defaults to what's playing.",
                    )
            )
            .addIntegerOption((o) =>
                o
                    .setName("count")
                    .setDescription(`Tracks to queue up front (default ${LIMITS.RADIO_TRACKS})`)
                    .setMinValue(1)
                    .setMaxValue(LIMITS.RADIO_MAX)
            ),
    guard: ensureVoice,
    handler: async (interaction, voiceChannel) => {
        const count = interaction.options.getInteger("count") ?? LIMITS.RADIO_TRACKS;
        const seedQuery = interaction.options.getString("seed");
        // A Turso round-trip plus the automix call runs past the 3s interaction
        // deadline often enough that /play's fast-path race isn't worth copying
        // here — /radio is not the hot path, so it just defers.
        await interaction.deferReply();
        const started = performance.now();

        let seed;
        try {
            seed = await resolveSeed(interaction, seedQuery);
        } catch (err) {
            if (err instanceof UserFacingError) return interaction.editReply(err.message);
            throw err;
        }
        if (!seed) {
            return interaction.editReply(
                seedQuery
                    ? "Couldn't turn that into a seed — try a YouTube link or a different search."
                    : "Nothing playing and no YouTube history to seed from — play a song first, or pass `seed:`.",
            );
        }

        const queue = getOrCreateQueue(interaction, voiceChannel);
        // Recent plays are excluded even though they aren't seeds: a station that
        // opens with the song someone heard ten minutes ago reads as broken.
        const recent = await getRecentSongs(interaction.guildId, LIMITS.RADIO_HISTORY_WINDOW);
        const exclude = new Set([
            seed.id,
            ...recent.map((row) => extractVideoId(row.url ?? "")).filter(Boolean),
            // Anything already waiting: enqueue only dedups single tracks, and a
            // radio batch takes the `many` branch.
            ...queue.songs.map((song) => extractVideoId(song.url ?? "")).filter(Boolean),
        ]);

        const tracks = await radioFrom([seed], { limit: count, exclude });
        if (!tracks.length) {
            return interaction.editReply("Couldn't find anything to play — YouTube returned no suggestions.");
        }

        const songs = radioSongs(tracks, interaction.user.tag, interaction.user.id);
        const result = enqueue(queue, songs, "📡 Radio");

        // Start the station *after* the first batch is in: the refill trigger fires
        // on queue movement, and arming it first would let it queue a second batch
        // against the same seed before this one had landed.
        queue.startStation({
            id: seed.id,
            title: seed.title,
            requestedBy: interaction.user.tag,
            requestedById: interaction.user.id,
        });
        // Seed the exclude set with this batch, and point the drift at its end, so
        // the first refill doesn't re-ask the question already answered here.
        for (const track of tracks) queue.station.exclude.add(track.id);
        queue.station.drift = { id: tracks.at(-1).id, title: tracks.at(-1).title };

        log.music(
            `Radio station started ${
                log.gray(
                    `seed "${seed.title}" (${seed.id}) · ${songs.length} queued in ${
                        Math.round(performance.now() - started)
                    }ms`,
                )
            }`,
        );
        // A count of 1 takes enqueue's `single` branch, which reports no count.
        return interaction.editReply({
            embeds: [radioQueued(result.count ?? 1, seed, interaction.user.tag)],
        });
    },
});

// One seed, three ways to get it, most specific first. Single by design: the
// station drifts from its seed as it plays, so a blend of five would have no
// coherent thing to drift *from* — and "radio of this song" is a promise.
async function resolveSeed(interaction, seedQuery) {
    if (seedQuery) {
        if (isYouTubeUrl(seedQuery)) {
            const id = extractVideoId(seedQuery);
            return id ? { id, title: seedQuery } : null;
        }
        // searchVideo throws UserFacingError when nothing matches, which the
        // handler shows as-is — the user's own words are what they can act on.
        const hit = await searchVideo(seedQuery);
        const id = extractVideoId(hit.url);
        return id ? { id, title: hit.title } : null;
    }

    // What's playing is the obvious station to extend, and seeding purely from
    // history could build one off last week's songs while something else is
    // audible right now.
    const current = queues.get(interaction.guildId)?.current;
    if (current?.url) {
        const id = extractVideoId(current.url);
        if (id) return { id, title: current.title };
    }

    const recent = await getRecentSongs(interaction.guildId, LIMITS.RADIO_HISTORY_WINDOW);
    for (const row of recent) {
        const id = extractVideoId(row.url ?? "");
        if (id) return { id, title: row.title };
    }
    return null;
}
