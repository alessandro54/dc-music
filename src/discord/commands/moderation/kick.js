import { PermissionFlagsBits } from "discord.js";

import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";

export default defineCommand({
    name: "kick",
    description: "Kick a member",
    permissions: PermissionFlagsBits.KickMembers,
    options: (b) =>
        b
            .addUserOption((o) => o.setName("user").setDescription("User to kick").setRequired(true))
            .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
    handler: async (interaction) => {
        const target = interaction.options.getMember("user");
        const reason = interaction.options.getString("reason") || "No reason provided";
        if (!target?.kickable) return interaction.reply(ephemeral("Cannot kick this user."));

        await target.kick(reason);
        await interaction.reply(`👢 **${target.user.tag}** kicked. Reason: ${reason}`);
    },
});
