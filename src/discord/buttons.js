import { ephemeral } from "@/discord/reply.js";
import { queues } from "@/discord/services/playbackService.js";
import { durationToMs } from "@/lib/utils.js";

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

    // The digit hotkeys — YouTube's 0–9, jump to that tenth of the track. The
    // fraction resolves against the duration at press time; a track whose
    // duration hasn't arrived yet can't be seeked into. Acknowledged first for
    // the same reason as the buttons below; the seek re-extracts (~3.5s),
    // during which the panel already shows the target position because the
    // time line reads seekOffset the moment it is set.
    if (interaction.customId.startsWith("np:seekpct:")) {
        const totalMs = durationToMs(queue.current?.duration);
        if (!totalMs) return interaction.reply(ephemeral("Can't seek yet — length unknown."));
        await interaction.deferUpdate();
        const tenth = Number(interaction.customId.slice("np:seekpct:".length));
        void queue.seek(Math.floor((tenth / 10) * (totalMs / 1000)));
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
