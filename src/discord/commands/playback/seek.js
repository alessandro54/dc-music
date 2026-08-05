import { requireCurrent } from "@/discord/guards.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";
import { formatMs, parseTimestamp } from "@/lib/utils.js";

export default defineCommand({
    name: "seek",
    description: "Seek to a position in the current song",
    options: (b) =>
        b.addStringOption((o) =>
            o.setName("position").setDescription("Timestamp (e.g. 1:30 or 90)").setRequired(true)
        ),
    guard: requireCurrent,
    handler: async (interaction, queue) => {
        const seconds = parseTimestamp(interaction.options.getString("position"));
        if (seconds === null || seconds < 0) {
            return interaction.reply(ephemeral("Invalid timestamp. Use `1:30` or `90`."));
        }

        await interaction.deferReply();
        const ok = await queue.seek(seconds);
        if (!ok) return interaction.editReply("Could not seek.");

        await interaction.editReply(`⏩ Seeked to **${formatMs(seconds * 1000)}**`);
    },
});
