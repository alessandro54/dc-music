import { REST, Routes } from "discord.js";
import { commands as registered } from "@/discord/commands.js";

const commands = registered
    .filter((c) => c?.data)
    .map((c) => c.data.toJSON());

const token = Deno.env.get("BOT_TOKEN") ?? Deno.env.get("DISCORD_TOKEN");
const guildId = Deno.env.get("GUILD_ID");
if (!token) throw new Error("BOT_TOKEN is not set — cannot register commands");
if (!guildId) throw new Error("GUILD_ID is not set — cannot register commands");

const rest = new REST().setToken(token);

// This runs as a Dokku postdeploy hook on every release, so a transient Discord
// blip would otherwise turn an otherwise-good deploy red.
async function withRetry(label, fn, attempts = 3) {
    for (let i = 1;; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts) throw new Error(`${label} failed after ${attempts} attempts: ${err.message}`);
            const wait = i * 2000;
            console.warn(`${label} failed (${err.message}) — retrying in ${wait}ms`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
}

// Ask the token which application it belongs to rather than trusting CLIENT_ID.
// An application id *is* its bot user's id, so this is authoritative and cannot
// drift. A stale CLIENT_ID publishes the commands to an app that isn't in the
// guild and the only symptom is a command that silently never appears — which is
// exactly how /leaderboard went missing.
const me = await withRetry("identify", () => rest.get(Routes.user("@me")));
console.log(`Deploying ${commands.length} commands as ${me.username} (${me.id}) to guild ${guildId}...`);

await withRetry(
    "register",
    () => rest.put(Routes.applicationGuildCommands(me.id, guildId), { body: commands }),
);
console.log("Commands deployed.");
