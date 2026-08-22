import { AttachmentBuilder } from "discord.js";

import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";
import { fetchDexEntry, getRandomPokemon } from "@/discord/services/pokemonService.js";
import { pokemonCard } from "@/discord/views/pokemonEmbed.js";

export default defineCommand({
    name: "pokemon",
    description: "Show a pokémon's dex entry, or a random one",
    options: (b) =>
        b.addStringOption((o) =>
            o.setName("name").setDescription("Which pokémon (spelled as in the games). Random if omitted.")
        ),
    // Lookup only, deliberately: catching happens on the timed spawns, where a
    // pokéball is spent and the first presser wins. A Catch button here would let
    // anyone name a legendary and take it on demand.
    handler: async (interaction) => {
        const name = interaction.options.getString("name");
        await interaction.deferReply();

        let sprite;
        try {
            sprite = await getRandomPokemon(name);
        } catch (err) {
            // The only failure worth a distinct message: a name colorscripts
            // doesn't know. Its stderr says so but not in words worth showing.
            if (name) return interaction.editReply(ephemeral(`Never heard of **${name}**.`));
            throw err;
        }

        // Awaited rather than backfilled — the card is the reply, so there is
        // nothing to edit later. `null` on failure keeps the sprite-only card.
        const dex = await fetchDexEntry(sprite.slug);
        await interaction.editReply({
            embeds: [pokemonCard(sprite.name, dex)],
            files: [new AttachmentBuilder(sprite.png, { name: "sprite.png" })],
        });
    },
});
