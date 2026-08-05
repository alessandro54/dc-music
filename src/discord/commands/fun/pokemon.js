import { AttachmentBuilder } from "discord.js";
import { getRandomPokemon } from "@/discord/services/pokemonService.js";
import { defineCommand } from "@/discord/router.js";
import { embed } from "@/discord/views/embeds.js";

export default defineCommand({
    name: "pokemon",
    description: "Show a random pokemon sprite",
    handler: async (interaction) => {
        await interaction.deferReply();
        const { name, png } = await getRandomPokemon();
        const file = new AttachmentBuilder(png, { name: "sprite.png" });
        await interaction.editReply({
            embeds: [embed().setTitle(name).setImage("attachment://sprite.png")],
            files: [file],
        });
    },
});
