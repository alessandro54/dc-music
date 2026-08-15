import { Client, Collection, GatewayIntentBits, Options } from "discord.js";

import { commands } from "@/discord/commands.js";
import { registerEvents } from "@/discord/events.js";
import { setClient } from "@/discord/services/playbackService.js";

// Builds the discord.js client and wires everything that hangs off it: the
// command collection the interaction handler looks commands up in, the event
// handlers, and the client reference playbackService needs for the bot presence.
// Caches are trimmed to what the bot reads — it never touches messages,
// reactions or presences, and an unbounded cache of those is pure resident memory.
export function createClient() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildVoiceStates,
        ],
        makeCache: Options.cacheWithLimits({
            MessageManager: 0,
            GuildMemberManager: 50,
            UserManager: 50,
            PresenceManager: 0,
            GuildStickerManager: 0,
            GuildInviteManager: 0,
            ReactionManager: 0,
            ReactionUserManager: 0,
            StageInstanceManager: 0,
            ThreadManager: 0,
            ThreadMemberManager: 0,
        }),
    });

    client.commands = new Collection();
    for (const cmd of commands) {
        if (cmd?.data && cmd?.execute) client.commands.set(cmd.data.name, cmd);
    }

    registerEvents(client);
    setClient(client);
    return client;
}
