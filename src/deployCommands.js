import { REST, Routes } from "discord.js";

import { commands as registered } from "@/discord/commands.js";

const commands = registered
    .filter((c) => c?.data)
    .map((c) => c.data.toJSON());

const rest = new REST().setToken(
    Deno.env.get("BOT_TOKEN") ?? Deno.env.get("DISCORD_TOKEN"),
);

console.log(`Deploying ${commands.length} commands...`);
await rest.put(
    Routes.applicationGuildCommands(
        Deno.env.get("CLIENT_ID"),
        Deno.env.get("GUILD_ID"),
    ),
    { body: commands },
);
console.log("Commands deployed.");
