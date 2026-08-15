import { requirePlaying } from "@/discord/guards.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";

export default defineCommand({
    name: "previous",
    description: "Go back to the previous song",
    guard: requirePlaying,
    handler: async (interaction, queue) => {
        const song = queue.previous();
        if (!song) return interaction.reply(ephemeral("Nothing played yet in this session."));
        await interaction.reply(`⏮️ Going back to **${song.title}**.`);
    },
});
