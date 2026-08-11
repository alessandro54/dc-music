import { PermissionFlagsBits } from "discord.js";

import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";

export default defineCommand({
    name: "timeout",
    description: "Timeout a member",
    permissions: PermissionFlagsBits.ModerateMembers,
    options: (b) =>
        b
            .addUserOption((o) => o.setName("user").setDescription("User to timeout").setRequired(true))
            .addIntegerOption((o) =>
                o
                    .setName("minutes")
                    .setDescription("Duration in minutes")
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(40320)
            )
            .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
    handler: async (interaction) => {
        const target = interaction.options.getMember("user");
        const minutes = interaction.options.getInteger("minutes");
        const reason = interaction.options.getString("reason") || "No reason provided";
        if (!target?.moderatable) return interaction.reply(ephemeral("Cannot time out this user."));

        await target.timeout(minutes * 60 * 1000, reason);
        await interaction.reply(
            `⏱️ **${target.user.tag}** timed out for ${minutes}min. Reason: ${reason}`,
        );
    },
});
