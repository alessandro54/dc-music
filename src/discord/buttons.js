import { ephemeral } from "@/discord/reply.js";
import { queues } from "@/discord/services/playbackService.js";

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
    if (!queue?.playing) return interaction.reply(ephemeral("Nothing playing."));

    // Anyone who can see the message can press the button, including someone who
    // isn't in the channel and can't hear what they are stopping. Slash commands
    // have ensureVoice for this; buttons had nothing.
    const botChannelId = interaction.guild.members.me?.voice?.channelId;
    if (botChannelId && interaction.member?.voice?.channelId !== botChannelId) {
        return interaction.reply(ephemeral("Join the voice channel to control playback."));
    }

    // The seek select — the panel's clickable progress bar. Acknowledged first
    // for the same reason as the buttons below; the seek itself re-extracts
    // (~3.5s), during which the panel already shows the target position because
    // progressLine reads seekOffset the moment it is set.
    if (interaction.isStringSelectMenu()) {
        await interaction.deferUpdate();
        const seconds = Number(interaction.values[0]);
        if (Number.isFinite(seconds)) void queue.seek(seconds);
        return;
    }

    const action = ACTIONS[interaction.customId.slice(NP_PREFIX.length)];
    if (!action) return interaction.deferUpdate();

    // Acknowledge before acting, not after: `stop` destroys the queue, which
    // deletes this very message — an update aimed at it afterwards has nothing
    // left to edit. The redraw is the panel's job either way (every action ends
    // in a queue state change, which is what refreshes it), so the button only
    // has to say "heard you".
    await interaction.deferUpdate();
    action(queue);
}
