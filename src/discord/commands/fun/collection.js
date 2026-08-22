import { defineCommand } from "@/discord/router.js";
import { ballsFor, collectionCount, getCollection } from "@/discord/services/pokemonService.js";
import { collectionEmbed } from "@/discord/views/pokemonEmbed.js";
import { LIMITS } from "@/lib/constants.js";

export default defineCommand({
    name: "collection",
    description: "Show a pokémon collection",
    options: (b) =>
        b.addUserOption((o) => o.setName("user").setDescription("Whose collection (defaults to you)")),
    handler: async (interaction) => {
        const target = interaction.options.getUser("user") ?? interaction.user;
        await interaction.deferReply();

        const [rows, total, balls] = await Promise.all([
            getCollection(interaction.guildId, target.id, LIMITS.COLLECTION_PAGE),
            collectionCount(interaction.guildId, target.id),
            // Only shown for the caller — someone else's pouch isn't theirs to act
            // on, and showing it invites ball-counting other people's chances.
            target.id === interaction.user.id ? ballsFor(interaction.guildId, target.id) : null,
        ]);

        await interaction.editReply({ embeds: [collectionEmbed(target, rows, total, balls)] });
    },
});
