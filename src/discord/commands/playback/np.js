import { requireCurrent } from "@/discord/guards.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";
import { movePanel } from "@/discord/services/nowPlayingService.js";
import { queues } from "@/discord/services/playbackService.js";

export default defineCommand({
    name: "np",
    description: "Show the currently playing song",
    guard: requireCurrent,
    handler: async (interaction) => {
        // There is one live panel per guild, so /np re-posts it at the bottom of
        // this channel rather than adding a second dashboard that would then
        // drift out of sync with the first. The ack is caller-only for the same
        // reason: a public reply would just push the panel back up.
        await interaction.reply(ephemeral("🎵 Now Playing panel moved here."));
        await movePanel(queues.get(interaction.guildId), interaction.channel);
    },
});
