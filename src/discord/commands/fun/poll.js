import { LIMITS, POLL_EMOJIS } from "@/lib/constants.js";
import { defineCommand } from "@/discord/router.js";
import { embed } from "@/discord/views/embeds.js";

export default defineCommand({
    name: "poll",
    description: "Create a poll",
    options: (b) =>
        b
            .addStringOption((o) => o.setName("question").setDescription("Poll question").setRequired(true))
            .addStringOption((o) =>
                o
                    .setName("options")
                    .setDescription("Options separated by | (max 5). Leave empty for yes/no")
                    .setRequired(false)
            ),
    handler: async (interaction) => {
        const question = interaction.options.getString("question");
        const raw = interaction.options.getString("options");
        const options = raw
            ? raw.split("|").map((o) => o.trim()).slice(0, LIMITS.POLL_OPTIONS)
            : ["Yes", "No"];

        const msg = await interaction.reply({
            embeds: [
                embed()
                    .setTitle(`📊 ${question}`)
                    .setDescription(options.map((o, i) => `${POLL_EMOJIS[i]} ${o}`).join("\n"))
                    .setFooter({ text: `Poll by ${interaction.user.tag}` }),
            ],
            fetchReply: true,
        });

        for (let i = 0; i < options.length; i++) {
            await msg.react(POLL_EMOJIS[i]);
        }
    },
});
