import { requireCurrent } from "@/discord/guards.js";
import { defineCommand } from "@/discord/router.js";
import { nowPlayingControls, nowPlayingEmbed } from "@/discord/views/musicEmbeds.js";

export default defineCommand({
    name: "np",
    description: "Show the currently playing song",
    guard: requireCurrent,
    handler: async (interaction, queue) => {
        await interaction.reply({
            embeds: [nowPlayingEmbed(queue)],
            components: [nowPlayingControls(queue)],
        });
    },
});
