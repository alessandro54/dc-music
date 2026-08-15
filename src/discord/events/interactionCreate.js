import { MessageFlags } from "discord.js";

import { handleNowPlayingButton, NP_PREFIX } from "@/discord/buttons.js";
import { log } from "@/lib/logger.js";
import { captureError, userFrom } from "@/lib/sentry.js";

export default {
    name: "interactionCreate",
    async execute(interaction, client) {
        if (interaction.isButton() && interaction.customId.startsWith(NP_PREFIX)) {
            return handleNowPlayingButton(interaction);
        }

        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        if (interaction.isAutocomplete()) {
            try {
                await command.autocomplete?.(interaction);
            } catch (err) {
                log.error(`autocomplete: ${err.message}`);
                captureError(err, {
                    tags: {
                        stage: "autocomplete",
                        command: interaction.commandName,
                        guild: interaction.guildId,
                    },
                    user: userFrom(interaction),
                });
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        log.cmd(
            `${log.bold(`/${interaction.commandName}`)} — ${interaction.user.tag} in #${
                interaction.channel?.name ?? "unknown"
            }`,
        );
        try {
            await command.execute(interaction, client);
        } catch (err) {
            log.error(`/${interaction.commandName} — ${err.message}`);
            captureError(err, {
                tags: { stage: "command", command: interaction.commandName, guild: interaction.guildId },
                extra: { options: interaction.options?.data },
                user: userFrom(interaction),
            });
            const msg = { content: "Command failed.", flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(msg);
            } else {
                await interaction.reply(msg);
            }
        }
    },
};
