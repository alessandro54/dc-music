import { queues } from "@/discord/services/playbackService.js";

// The bot used to sit in the channel after everyone left, until the queue-idle
// timer happened to fire. Watch the channel it is actually in instead: when the
// last human leaves, GuildQueue starts its own grace timer and leaves; when
// someone comes back, that timer is cancelled.
export default {
    name: "voiceStateUpdate",
    execute(oldState, newState) {
        const guild = newState.guild ?? oldState.guild;
        const queue = queues.get(guild.id);
        if (!queue) return;

        const botChannel = guild.members.me?.voice?.channel;
        if (!botChannel) return;

        // Only the bot's own channel matters — activity anywhere else is noise.
        if (oldState.channelId !== botChannel.id && newState.channelId !== botChannel.id) return;

        const humans = botChannel.members.filter((m) => !m.user.bot).size;
        if (humans === 0) queue.markAlone();
        else queue.markNotAlone();
    },
};
