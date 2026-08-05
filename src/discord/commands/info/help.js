import { defineCommand } from "@/discord/router.js";
import { embed } from "@/discord/views/embeds.js";

export default defineCommand({
    name: "help",
    description: "Show all commands",
    handler: async (interaction) => {
        // Lazy import on purpose: commands.js registers this command, so importing
        // it at the top would be a cycle. Reading the groups from the router is
        // what keeps this list from going stale — a newly registered command shows
        // up here without touching this file.
        const { router } = await import("@/discord/commands.js");
        await interaction.reply({
            embeds: [
                embed().setTitle("Bot Commands").addFields(
                    router.visibleGroups().map((group) => ({
                        name: group.label,
                        value: group.names.map((name) => `\`/${name}\``).join(" "),
                    })),
                ),
            ],
        });
    },
});
