import { autocomplete } from "@/discord/commands/playback/play/autocomplete.js";
import { ensureVoice } from "@/discord/guards.js";
import { resolveQuery } from "@/discord/resolvers/index.js";
import { defineCommand } from "@/discord/router.js";
import { enqueue, getOrCreateQueue } from "@/discord/services/playbackService.js";
import { playlistQueued, trackQueued } from "@/discord/views/musicEmbeds.js";
import { log } from "@/lib/logger.js";
import { captureError, userFrom } from "@/lib/sentry.js";

// Discord kills an interaction that isn't acknowledged within 3s. Resolving
// usually finishes in ~30ms (raced metadata sources), so waiting briefly lets
// the final embed BE the acknowledgement — one round-trip instead of two.
// Measured on prod: a round-trip costs 416-908ms while resolving costs 28ms,
// so the "🔍 Searching…" placeholder was most of what the user waited for.
// The margin below 3s covers the reply's own transit.
const FAST_PATH_MS = 2000;

const SLOW = Symbol("resolve-too-slow");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default defineCommand({
    name: "play",
    description: "Play a song or playlist from YouTube or Spotify",
    options: (b) =>
        b.addStringOption((o) =>
            o
                .setName("query")
                .setDescription("YouTube/Spotify URL or search query")
                .setRequired(true)
                .setAutocomplete(true)
        ),
    autocomplete,
    guard: ensureVoice,
    handler: async (interaction, voiceChannel) => {
        const query = interaction.options.getString("query");
        const started = performance.now();

        const pending = resolveQuery(query, interaction.user.tag, interaction.user.id);
        // Parked immediately: if the race below picks the timeout, nothing is
        // awaiting this yet and a rejection would surface as unhandledRejection.
        pending.catch(() => {});

        let resolved;
        let placeholder = null; // set only when we fall back to acknowledging first
        try {
            resolved = await Promise.race([pending, sleep(FAST_PATH_MS).then(() => SLOW)]);

            if (resolved === SLOW) {
                // Slow query (private video, playlist dump, cold yt-dlp). Claim
                // the interaction before Discord expires it, then edit it later.
                placeholder = interaction.reply({ content: `🔍 Searching for **${query}**…` });
                placeholder.catch(() => {});
                resolved = await pending;
            }
        } catch (err) {
            log.error(`[play] resolve: ${err.message}`);
            captureError(err, {
                tags: { stage: "resolve", command: "play", guild: interaction.guildId },
                extra: { query },
                user: userFrom(interaction),
            });
            return respond(interaction, placeholder, "Could not find that song or playlist.");
        }

        const resolveMs = Math.round(performance.now() - started);

        const { songs, playlistName } = resolved;
        if (!songs.length) return respond(interaction, placeholder, "No results found.");

        const queue = getOrCreateQueue(interaction, voiceChannel);
        const result = enqueue(queue, songs, playlistName);

        let payload;
        switch (result.kind) {
            case "duplicate":
                payload = `**${result.song.title}** is already in the queue at position #${result.position}.`;
                break;
            case "single":
                log.music(
                    `Enqueued ${log.bold(result.song.title)} ${log.gray(`by ${interaction.user.tag}`)}`,
                );
                payload = { embeds: [trackQueued(result.song, result.isFirst, result.position)] };
                break;
            case "many":
                payload = {
                    embeds: [playlistQueued(result.count, result.playlistName, interaction.user.tag)],
                };
                break;
        }

        await respond(interaction, placeholder, payload);
        log.music(
            log.gray(
                `resolved in ${resolveMs}ms · ${placeholder ? "2 round-trips" : "1 round-trip"} · ready ${
                    Math.round(performance.now() - started)
                }ms`,
            ),
        );
    },
});

// One reply, whichever phase we're in: if the interaction was already claimed by
// a placeholder we have to edit it, otherwise this reply IS the acknowledgement.
// Either call can fail on a dead token — the track is queued regardless, so a
// lost reply must not throw away the user's request.
async function respond(interaction, placeholder, payload) {
    if (placeholder) {
        try {
            await placeholder;
        } catch (err) {
            log.error(`[play] ack: ${err.message}`);
            return; // token is gone; editReply can't work either
        }
        return interaction.editReply(payload).catch((err) => {
            log.error(`[play] editReply: ${err.message}`);
        });
    }
    return interaction.reply(payload).catch((err) => {
        log.error(`[play] reply: ${err.message}`);
    });
}
