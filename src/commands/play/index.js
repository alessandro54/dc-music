import { SlashCommandBuilder } from "discord.js";
import { ensureVoice } from "../../lib/guards.js";
import { log } from "../../lib/logger.js";
import { captureError, userFrom } from "../../lib/sentry.js";
import { enqueue, getOrCreateQueue } from "../../services/music/playback.js";
import { resolveQuery } from "../../services/music/resolver.js";
import { playlistQueued, trackQueued } from "../../views/musicEmbeds.js";
import { autocomplete } from "./autocomplete.js";

export default {
    autocomplete,
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play a song or playlist from YouTube or Spotify")
        .addStringOption((o) =>
            o
                .setName("query")
                .setDescription("YouTube/Spotify URL or search query")
                .setRequired(true)
                .setAutocomplete(true),
        ),
    async execute(interaction) {
        const voiceChannel = ensureVoice(interaction);
        if (!voiceChannel) return;

        const query = interaction.options.getString("query");
        await interaction.reply({ content: `🔍 Searching for **${query}**…` });

        let resolved;
        try {
            resolved = await resolveQuery(query, interaction.user.tag, interaction.user.id);
        } catch (err) {
            log.error(`[play] resolve: ${err.message}`);
            captureError(err, {
                tags: { stage: "resolve", command: "play", guild: interaction.guildId },
                extra: { query },
                user: userFrom(interaction),
            });
            return interaction.editReply("Could not find that song or playlist.");
        }

        const { songs, playlistName } = resolved;
        if (!songs.length) return interaction.editReply("No results found.");

        const queue = getOrCreateQueue(interaction, voiceChannel);
        const result = enqueue(queue, songs, playlistName);

        switch (result.kind) {
            case "duplicate":
                return interaction.editReply(
                    `**${result.song.title}** is already in the queue at position #${result.position}.`,
                );
            case "single":
                log.music(`Enqueued ${log.bold(result.song.title)} ${log.gray(`by ${interaction.user.tag}`)}`);
                return interaction.editReply({ embeds: [trackQueued(result.song, result.isFirst, result.position)] });
            case "many":
                return interaction.editReply({
                    embeds: [playlistQueued(result.count, result.playlistName, interaction.user.tag)],
                });
        }
    },
};
