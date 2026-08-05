import { defineCommand } from "@/discord/router.js";
import { embed } from "@/discord/views/embeds.js";

export default defineCommand({
    name: "serverinfo",
    description: "Show server info",
    handler: async (interaction) => {
        const { guild } = interaction;
        await interaction.reply({
            embeds: [
                embed()
                    .setTitle(guild.name)
                    .setThumbnail(guild.iconURL())
                    .addFields(
                        { name: "Members", value: `${guild.memberCount}`, inline: true },
                        {
                            name: "Created",
                            value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,
                            inline: true,
                        },
                        { name: "Owner", value: `<@${guild.ownerId}>`, inline: true },
                        { name: "Channels", value: `${guild.channels.cache.size}`, inline: true },
                        { name: "Roles", value: `${guild.roles.cache.size}`, inline: true },
                        { name: "Boost Level", value: `Tier ${guild.premiumTier}`, inline: true },
                    ),
            ],
        });
    },
});
