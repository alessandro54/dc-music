import { PermissionFlagsBits } from "discord.js";
import { getConfig, setConfig } from "@/lib/config.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";

export default defineCommand({
    name: "setup",
    description: "Configure bot settings for this server",
    permissions: PermissionFlagsBits.ManageGuild,
    options: (b) =>
        b
            .addSubcommand((s) =>
                s
                    .setName("welcome")
                    .setDescription("Set the welcome channel")
                    .addChannelOption((o) =>
                        o
                            .setName("channel")
                            .setDescription("Channel to send welcome messages")
                            .setRequired(true)
                    )
            )
            .addSubcommand((s) =>
                s
                    .setName("rules")
                    .setDescription("Set the rules channel (linked in welcome message)")
                    .addChannelOption((o) =>
                        o.setName("channel").setDescription("Rules channel").setRequired(true)
                    )
            )
            .addSubcommand((s) => s.setName("show").setDescription("Show current configuration")),
    handler: (interaction) => {
        const sub = interaction.options.getSubcommand();

        if (sub === "show") {
            const config = getConfig(interaction.guildId);
            return interaction.reply(ephemeral(
                [
                    `**Bot config for this server:**`,
                    `Welcome channel: ${
                        config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : "not set"
                    }`,
                    `Rules channel: ${config.rules_channel_id ? `<#${config.rules_channel_id}>` : "not set"}`,
                ].join("\n"),
            ));
        }

        const channel = interaction.options.getChannel("channel");
        const patch = sub === "welcome"
            ? { welcome_channel_id: channel.id }
            : { rules_channel_id: channel.id };

        setConfig(interaction.guildId, patch);
        return interaction.reply(ephemeral(
            `✅ ${sub === "welcome" ? "Welcome" : "Rules"} channel set to <#${channel.id}>`,
        ));
    },
});
