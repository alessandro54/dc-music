import { requirePlaying } from "@/discord/guards.js";
import { defineCommand } from "@/discord/router.js";

// pause/resume/skip/stop are the same route three steps long: require a playing
// queue, call one method, say so. `reply` may be a function when the message
// depends on the queue — it is evaluated *before* `act`, so /skip can name the
// track it is about to drop.
function control({ name, description, act, reply }) {
    return defineCommand({
        name,
        description,
        guard: requirePlaying,
        handler: async (interaction, queue) => {
            const message = typeof reply === "function" ? reply(queue) : reply;
            act(queue);
            await interaction.reply(message);
        },
    });
}

export const pause = control({
    name: "pause",
    description: "Pause playback",
    act: (q) => q.pause(),
    reply: "⏸️ Paused.",
});

export const resume = control({
    name: "resume",
    description: "Resume playback",
    act: (q) => q.resume(),
    reply: "▶️ Resumed.",
});

export const skip = control({
    name: "skip",
    description: "Skip the current song",
    act: (q) => q.skip(),
    reply: (q) => `⏭️ Skipped **${q.current?.title ?? "song"}**.`,
});

export const stop = control({
    name: "stop",
    description: "Stop music and clear the queue",
    act: (q) => q.stop(),
    reply: "⏹️ Stopped and cleared queue.",
});
