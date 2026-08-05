import { LIMITS } from "@/lib/constants.js";
import { getTopSongs } from "@/discord/services/trackService.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";
import { leaderboardEmbed } from "@/discord/views/musicEmbeds.js";

export default defineCommand({
    name: "leaderboard",
    description: "Show the most played songs in this server",
    handler: async (interaction) => {
        const songs = await getTopSongs(interaction.guildId, LIMITS.LEADERBOARD);
        if (!songs.length) return interaction.reply(ephemeral("Nothing has been played here yet."));

        await interaction.reply({ embeds: [leaderboardEmbed(songs)] });
    },
});
