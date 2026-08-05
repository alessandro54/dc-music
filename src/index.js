import { Client, Collection, GatewayIntentBits, Options } from "discord.js";
import { commands } from "@/discord/commands.js";
import guildMemberAdd from "@/discord/events/guildMemberAdd.js";
import interactionCreate from "@/discord/events/interactionCreate.js";
import ready from "@/discord/events/ready.js";
import { COMMIT, COMMIT_URL } from "@/lib/buildInfo.js";
import { initDb } from "@/db/client.js";
import { log } from "@/lib/logger.js";
// Importing sentry.js runs Sentry.init — it happens during module evaluation,
// before any of the code below can throw.
import { captureError } from "@/lib/sentry.js";
import { startServer } from "@/lib/server.js";
import { queues, setClient } from "@/discord/services/playbackService.js";
import { shutdownStreams } from "@/discord/services/ytdlpService.js";

process.on("unhandledRejection", (err) => {
    log.error(`unhandledRejection: ${err}`);
    captureError(err, { tags: { stage: "process" }, level: "error" });
});
process.on("uncaughtException", (err) => {
    log.error(`uncaughtException: ${err}`);
    captureError(err, { tags: { stage: "process" }, level: "fatal" });
});

log.info(`revision: ${COMMIT_URL ?? COMMIT}`);

const ytdlpBin = `${import.meta.dirname}/yt-dlp`;
try {
    Deno.statSync(ytdlpBin);
    try {
        Deno.chmodSync(ytdlpBin, 0o755);
    } catch { /* already executable */ }
    Deno.env.set("YTDLP_PATH", ytdlpBin);
} catch { /* no bundled binary — fall through to PATH */ }
Deno.env.set(
    "PATH",
    `${import.meta.dirname}${Deno.build.os === "windows" ? ";" : ":"}${Deno.env.get("PATH")}`,
);

await initDb();

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

for (const event of [guildMemberAdd, interactionCreate, ready]) {
    const { name, once, execute } = event;
    client[once ? "once" : "on"](name, (...args) => execute(...args, client));
}

setClient(client);

const port = Deno.env.get("SERVER_PORT") || Deno.env.get("PORT") || 3000;
startServer(port, queues, client);

client.login(Deno.env.get("BOT_TOKEN"));

// Dokku sends SIGTERM on every redeploy. Container teardown would kill the
// whole cgroup anyway, so this isn't about leaked processes — it's about going
// down cleanly: leave the voice channels, stop the players, reap our own yt-dlp
// children rather than having them die mid-write.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
    Deno.addSignalListener(signal, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`${signal} — shutting down`);
        try {
            for (const queue of [...queues.values()]) queue.destroy();
            await shutdownStreams();
            await client.destroy();
        } catch (err) {
            log.error(`shutdown: ${err.message}`);
        }
        Deno.exit(0);
    });
}
