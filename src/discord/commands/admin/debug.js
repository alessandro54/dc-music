import { MessageFlags, PermissionFlagsBits } from "discord.js";

import { requireOwner } from "@/discord/guards.js";
import { defineCommand } from "@/discord/router.js";
import { getHealth } from "@/discord/services/healthService.js";
import { healthEmbed } from "@/discord/views/healthEmbed.js";

export default defineCommand({
    name: "debug",
    description: "Show bot health & diagnostics",
    // Admin-only: hidden from regular members in the command picker.
    permissions: PermissionFlagsBits.Administrator,
    guard: requireOwner,
    handler: async (interaction) => {
        const health = getHealth(interaction.client);
        await interaction.reply({ embeds: [healthEmbed(health)], flags: MessageFlags.Ephemeral });
    },
});
