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
        const started = performance.now();

        // Acknowledge and resolve concurrently. The ACK is a round-trip to
        // Discord (measured 581-704ms on prod — longer than the resolve itself)
        // and resolving doesn't depend on it, so awaiting it first made every
        // /play pay both in series. Only editReply needs the ACK to have landed.
        let ackMs = null;
        const ack = interaction.reply({ content: `🔍 Searching for **${query}**…` })
            .then(() => {
                ackMs = Math.round(performance.now() - started);
            });
        // Parked until after the resolve — without a handler now, a failed ACK
        // would surface as an unhandledRejection before anyone awaits it.
        ack.catch(() => {});

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
            await ack.catch(() => {});
            return interaction.editReply("Could not find that song or playlist.").catch(() => {});
        }
        const resolveMs = Math.round(performance.now() - started);

        // editReply requires the ACK; whatever is left of it is the real cost.
        // A failed ACK means the interaction is gone (expired/already answered),
        // so editReply can't work either — queue the track anyway and skip the
        // reply rather than dropping the user's request over a dead token.
        let acked = true;
        try {
            await ack;
        } catch (err) {
            acked = false;
            log.error(`[play] ack: ${err.message}`);
        }
        log.music(log.gray(`resolved in ${resolveMs}ms · ack ${ackMs ?? "failed"}ms · ready ${Math.round(performance.now() - started)}ms`));

        const reply = (payload) => (acked ? interaction.editReply(payload).catch(() => {}) : null);

        const { songs, playlistName } = resolved;
        if (!songs.length) return reply("No results found.");

        const queue = getOrCreateQueue(interaction, voiceChannel);
        const result = enqueue(queue, songs, playlistName);

        switch (result.kind) {
            case "duplicate":
                return reply(`**${result.song.title}** is already in the queue at position #${result.position}.`);
            case "single":
                log.music(`Enqueued ${log.bold(result.song.title)} ${log.gray(`by ${interaction.user.tag}`)}`);
                return reply({ embeds: [trackQueued(result.song, result.isFirst, result.position)] });
            case "many":
                return reply({ embeds: [playlistQueued(result.count, result.playlistName, interaction.user.tag)] });
        }
    },
};
