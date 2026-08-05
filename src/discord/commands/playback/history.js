import { LIMITS } from "@/lib/constants.js";
import { getHistory } from "@/discord/services/trackService.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";
import { embed } from "@/discord/views/embeds.js";

export default defineCommand({
    name: "history",
    description: "Show recently played songs",
    handler: async (interaction) => {
        const songs = await getHistory(interaction.guildId, LIMITS.HISTORY);
        if (!songs.length) return interaction.reply(ephemeral("No history yet."));

        await interaction.reply({
            embeds: [
                embed()
                    .setTitle("🎵 Recently Played")
                    .setDescription(
                        songs
                            .map((s, i) => `\`${i + 1}.\` **[${s.title}](${s.url})** · ${s.userTag}`)
                            .join("\n"),
                    ),
            ],
        });
    },
});
