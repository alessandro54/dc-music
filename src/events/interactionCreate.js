import { MessageFlags } from "discord.js";
import { log } from "../lib/logger.js";
import { queues } from "../services/music/guildQueue.js";
import { nowPlayingControls, nowPlayingEmbed } from "../views/musicEmbeds.js";

export default {
    name: "interactionCreate",
    async execute(interaction, client) {
        if (interaction.isButton() && interaction.customId.startsWith("np:")) {
            const queue = queues.get(interaction.guildId);
            const action = interaction.customId.split(":")[1];

            if (!queue?.playing) {
                return interaction.update({
                    content: "Nothing playing.",
                    embeds: [],
                    components: [],
                });
            }

            if (action === "pause") queue.pause();
            else if (action === "skip") queue.skip();
            else if (action === "stop") queue.stop();

            if (action === "stop" || !queue.current) {
                return interaction.update({
                    content: "⏹️ Stopped.",
                    embeds: [],
                    components: [],
                });
            }

            return interaction.update({
                embeds: [nowPlayingEmbed(queue)],
                components: [nowPlayingControls(queue)],
            });
        }

        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        if (interaction.isAutocomplete()) {
            try {
                await command.autocomplete?.(interaction);
            } catch (err) {
                log.error(`autocomplete: ${err.message}`);
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        log.cmd(
            `${log.bold(`/${interaction.commandName}`)} — ${interaction.user.tag} in #${interaction.channel?.name ?? "unknown"}`,
        );
        try {
            await command.execute(interaction, client);
        } catch (err) {
            log.error(`/${interaction.commandName} — ${err.message}`);
            const msg = { content: "Command failed.", flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(msg);
            } else {
                await interaction.reply(msg);
            }
        }
    },
};
