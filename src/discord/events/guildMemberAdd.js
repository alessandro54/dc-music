import { embed } from "@/discord/views/embeds.js";
import { getConfig } from "@/lib/config.js";

export default {
    name: "guildMemberAdd",
    async execute(member) {
        const config = getConfig(member.guild.id);
        if (!config.welcome_channel_id) return;

        const channel = member.guild.channels.cache.get(config.welcome_channel_id);
        if (!channel) return;

        channel.send({
            embeds: [
                embed()
                    .setTitle("Welcome! 🎮")
                    .setDescription(
                        `Hey ${member}, glad you're here!${
                            config.rules_channel_id
                                ? `\nCheck out <#${config.rules_channel_id}> to get started.`
                                : ""
                        }`,
                    )
                    .setThumbnail(member.user.displayAvatarURL())
                    .setFooter({ text: `Member #${member.guild.memberCount}` }),
            ],
        });
    },
};
