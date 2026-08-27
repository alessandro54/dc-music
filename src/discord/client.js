import { Client, Collection, GatewayIntentBits, Options } from "discord.js";

import { commands } from "@/discord/commands.js";
import { registerEvents } from "@/discord/events.js";
import { setClient } from "@/discord/services/playbackService.js";

// Builds the discord.js client and wires everything that hangs off it: the
// command collection the interaction handler looks commands up in, the event
// handlers, and the client reference playbackService needs for the bot presence.
// Caches are trimmed to what the bot reads — it holds one message per guild (the
// Now Playing panel, kept by reference, not by cache) and never touches reactions
// or presences, where an unbounded cache is pure resident memory.
export function createClient() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildVoiceStates,
            // Only for messageCreate, which the Now Playing panel uses to notice
            // it has been pushed up the channel. Non-privileged: it delivers the
            // event, not the message content.
            GatewayIntentBits.GuildMessages,
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
