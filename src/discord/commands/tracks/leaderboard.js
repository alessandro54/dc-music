import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";
import { getTopDjs, getTopSongs } from "@/discord/services/trackService.js";
import { leaderboardEmbed } from "@/discord/views/musicEmbeds.js";
import { LIMITS } from "@/lib/constants.js";

export default defineCommand({
    name: "leaderboard",
    description: "Show the most played songs and top DJs in this server",
    handler: async (interaction) => {
        // Two independent aggregates — on Turso each is its own HTTP round-trip,
        // so racing them costs one wait instead of two.
        const [songs, djs] = await Promise.all([
            getTopSongs(interaction.guildId, LIMITS.LEADERBOARD),
            getTopDjs(interaction.guildId, LIMITS.DJ_LEADERBOARD),
        ]);
        if (!songs.length) return interaction.reply(ephemeral("Nothing has been played here yet."));

        await interaction.reply({ embeds: [leaderboardEmbed(songs, djs)] });
    },
});
