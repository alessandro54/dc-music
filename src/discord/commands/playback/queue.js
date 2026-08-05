import { queues } from "@/discord/services/playbackService.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";
import { queueEmbed } from "@/discord/views/musicEmbeds.js";

export default defineCommand({
    name: "queue",
    description: "Show the current queue",
    handler: async (interaction) => {
        // Not requirePlaying: a paused queue still has a list worth showing.
        const queue = queues.get(interaction.guildId);
        if (!queue?.songs.length) return interaction.reply(ephemeral("Queue is empty."));
        await interaction.reply({ embeds: [queueEmbed(queue)] });
    },
});
