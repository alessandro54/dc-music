import guildMemberAdd from "@/discord/events/guildMemberAdd.js";
import interactionCreate from "@/discord/events/interactionCreate.js";
import messageCreate from "@/discord/events/messageCreate.js";
import ready from "@/discord/events/ready.js";
import voiceStateUpdate from "@/discord/events/voiceStateUpdate.js";

// The event table — the counterpart to commands.js. Every handler is imported
// here and nowhere else; there is no filesystem scan, so `deno check` still sees
// the whole graph. Each module exports { name, once?, execute(...args, client) }.
export const events = [guildMemberAdd, interactionCreate, messageCreate, ready, voiceStateUpdate];

export function registerEvents(client) {
    for (const { name, once, execute } of events) {
        client[once ? "once" : "on"](name, (...args) => execute(...args, client));
    }
}
