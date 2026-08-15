import { ephemeral } from "@/discord/reply.js";
import { queues } from "@/discord/services/playbackService.js";
import { nowPlayingControls, nowPlayingEmbed } from "@/discord/views/musicEmbeds.js";

// Component routes, the counterpart to router.js for buttons. A custom id is
// `np:<action>`; the action names a function here. Keeping the table here rather
// than in the event handler means adding a button is one entry, and the guard
// below can't be forgotten for it.
//
// The pause entry toggles: the button *renders* as ▶️ once paused (see
// nowPlayingControls), so a press while paused means resume. Calling pause()
// unconditionally left the only way to resume as typing /resume.
const ACTIONS = {
    previous: (queue) => queue.previous(),
    pause: (queue) => (queue.paused ? queue.resume() : queue.pause()),
    skip: (queue) => queue.skip(),
    stop: (queue) => queue.stop(),
};

export const NP_PREFIX = "np:";

export async function handleNowPlayingButton(interaction) {
    const queue = queues.get(interaction.guildId);
    if (!queue?.playing) {
        return interaction.update({ content: "Nothing playing.", embeds: [], components: [] });
    }

    // Anyone who can see the message can press the button, including someone who
    // isn't in the channel and can't hear what they are stopping. Slash commands
    // have ensureVoice for this; buttons had nothing.
    const botChannelId = interaction.guild.members.me?.voice?.channelId;
    if (botChannelId && interaction.member?.voice?.channelId !== botChannelId) {
        return interaction.reply(ephemeral("Join the voice channel to control playback."));
    }

    const action = ACTIONS[interaction.customId.slice(NP_PREFIX.length)];
    if (!action) return interaction.deferUpdate();
    action(queue);

    if (!queue.playing || !queue.current) {
        return interaction.update({ content: "⏹️ Stopped.", embeds: [], components: [] });
    }
    return interaction.update({
        embeds: [nowPlayingEmbed(queue)],
        components: [nowPlayingControls(queue)],
    });
}
