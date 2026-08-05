import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { requireOwner } from "@/discord/guards.js";
import { reloadCookies } from "@/discord/services/ytdlpService.js";
import { ephemeral } from "@/discord/reply.js";
import { defineCommand } from "@/discord/router.js";

export default defineCommand({
    name: "setcookies",
    description: "Hot-reload YouTube cookies from an uploaded cookies.txt",
    // Admin-only: hidden from regular members in the command picker.
    permissions: PermissionFlagsBits.Administrator,
    options: (b) =>
        b.addAttachmentOption((o) =>
            o.setName("file").setDescription("Netscape-format cookies.txt").setRequired(true)
        ),
    guard: requireOwner,
    handler: async (interaction) => {
        const file = interaction.options.getAttachment("file", true);
        if (file.size > 1_000_000) {
            return interaction.reply(ephemeral("That's too big to be a cookies.txt."));
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const text = await (await fetch(file.url)).text();
        if (!text.includes("\t")) {
            return interaction.editReply(
                "Doesn't look like a Netscape cookies.txt (no tab-separated fields).",
            );
        }

        reloadCookies(text);
        await interaction.editReply(
            "Cookies reloaded — live immediately, no restart needed. This won't survive the next " +
                "deploy/restart though: also update the `YOUTUBE_COOKIES` config var on the host for that.",
        );
    },
});
