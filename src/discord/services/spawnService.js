import { AttachmentBuilder } from "discord.js";

import { spawnRow } from "@/discord/pokemonButtons.js";
import {
    attachSpawnMessage,
    fetchDexEntry,
    getRandomPokemon,
    recordSpawn,
} from "@/discord/services/pokemonService.js";
import { spawnCard } from "@/discord/views/pokemonEmbed.js";
import { TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";
import { captureError } from "@/lib/sentry.js";

// A wild pokémon appears on a timer. The channel is config, not code: a spawn
// every 10 minutes is 144 messages a day, which belongs wherever the server wants
// the noise rather than wherever the bot happens to have been used last.
const CHANNEL_ID = () => Deno.env.get("POKEMON_SPAWN_CHANNEL_ID");

let timer = null;

export function startSpawns(client) {
    if (!CHANNEL_ID()) {
        log.info("[spawn] POKEMON_SPAWN_CHANNEL_ID unset — wild pokémon disabled");
        return;
    }
    // Interval only, no catch-up on boot: a deploy in the middle of a window
    // should not immediately fire a spawn, or a run of releases would flood the
    // channel. The rhythm restarting is the lesser cost.
    timer = setInterval(() => void spawnOnce(client), TIMEOUTS.POKEMON_SPAWN_MS);
    log.info(`[spawn] wild pokémon every ${TIMEOUTS.POKEMON_SPAWN_MS / 60_000}min → #${CHANNEL_ID()}`);
}

export function stopSpawns() {
    clearInterval(timer);
    timer = null;
}

export async function spawnOnce(client) {
    const channelId = CHANNEL_ID();
    if (!channelId) return null;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) {
            log.warn(`[spawn] ${channelId} is not a text channel`);
            return null;
        }

        // colorscripts is a short-lived python process, and the box has 2 cores
        // that playback also wants. It is one spawn per 10 minutes against a
        // yt-dlp per track, so it is not worth gating — but it is the reason this
        // never runs on the /play path.
        const sprite = await getRandomPokemon();
        const dex = await fetchDexEntry(sprite.slug);

        // The row exists before the message so the button can carry its id — the
        // spawn id is what makes "first to catch" resolvable at all.
        const spawnId = await recordSpawn({
            guildId: channel.guildId,
            channelId,
            slug: sprite.slug,
            dexId: dex?.id ?? null,
        });
        if (!spawnId) {
            log.warn("[spawn] no database — skipping");
            return null;
        }

        const message = await channel.send({
            embeds: [spawnCard(sprite.name, dex)],
            components: [spawnRow(spawnId)],
            files: [new AttachmentBuilder(sprite.png, { name: "sprite.png" })],
        });
        void attachSpawnMessage(spawnId, message.id);
        log.info(`[spawn] ${sprite.slug} (#${spawnId})`);
        return spawnId;
    } catch (err) {
        // A failed spawn must never stop the interval — the next one is 10
        // minutes away and the bot's real job is unaffected.
        log.error(`[spawn] ${err.message}`);
        captureError(err, { tags: { stage: "spawn" } });
        return null;
    }
}
