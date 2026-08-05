import { PermissionFlagsBits } from "discord.js";
import { queues } from "@/discord/services/playbackService.js";
import { ephemeral } from "@/discord/reply.js";

// Route middleware — see defineCommand in router.js. Each returns the value the
// handler needs, or null after replying with the reason.

export function requirePlaying(interaction) {
    const queue = queues.get(interaction.guildId);
    if (!queue?.playing) {
        interaction.reply(ephemeral("Nothing playing."));
        return null;
    }
    return queue;
}

// requirePlaying plus a loaded track — for commands that read the current song
// (np, seek) rather than just acting on the queue.
export function requireCurrent(interaction) {
    const queue = requirePlaying(interaction);
    if (!queue) return null;
    if (!queue.current) {
        interaction.reply(ephemeral("Nothing playing."));
        return null;
    }
    return queue;
}

// Returns the caller's voice channel if the bot can join+speak there,
// otherwise replies with the reason and returns null.
export function ensureVoice(interaction) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        interaction.reply(ephemeral("Join a voice channel first."));
        return null;
    }
    const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!perms.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak)) {
        interaction.reply(
            ephemeral("I don't have permission to join or speak in that voice channel."),
        );
        return null;
    }
    return voiceChannel;
}

// OWNER_ID gate on top of the admin-only permission in `data`: the permission
// hides the command in the picker, this stops anyone who reaches it anyway.
// Unset OWNER_ID leaves the permission as the only gate.
export function requireOwner(interaction) {
    const ownerId = Deno.env.get("OWNER_ID");
    if (ownerId && interaction.user.id !== ownerId) {
        interaction.reply(ephemeral("Not authorized."));
        return null;
    }
    return interaction.user;
}
