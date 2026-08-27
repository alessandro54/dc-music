import { autocomplete } from "@/discord/commands/playback/play/autocomplete.js";
import { ensureVoice } from "@/discord/guards.js";
import { ephemeral } from "@/discord/reply.js";
import { resolveQuery } from "@/discord/resolvers/index.js";
import { defineCommand } from "@/discord/router.js";
import { enqueue, getOrCreateQueue } from "@/discord/services/playbackService.js";
import { playlistQueued } from "@/discord/views/musicEmbeds.js";
import { componentPayload, queuedView } from "@/discord/views/nowPlaying.js";
import { UserFacingError } from "@/lib/errors.js";
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

// /play and /playnow are one command declared twice: same input, same resolve,
// same reply — the only difference is where the songs land, which is `next`.
// A second file with a copy of the body is how those two drift apart.
export function definePlay({ name, description, next = false }) {
    return defineCommand({
        name,
        description,
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
        handler: (interaction, voiceChannel) => run(interaction, voiceChannel, { name, next }),
    });
}

async function run(interaction, voiceChannel, { name, next }) {
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
        // The message was written for whoever typed the query — showing the
        // generic refusal instead threw away the one thing that told them
        // what to do differently.
        if (err instanceof UserFacingError) {
            log.warn(`[${name}] ${err.message}`);
            return respond(interaction, placeholder, err.message);
        }
        log.error(`[${name}] resolve: ${err.message}`);
        captureError(err, {
            tags: { stage: "resolve", command: name, guild: interaction.guildId },
            extra: { query },
            user: userFrom(interaction),
        });
        return respond(interaction, placeholder, "Could not find that song or playlist.");
    }

    const resolveMs = Math.round(performance.now() - started);

    const { songs, playlistName } = resolved;
    if (!songs.length) return respond(interaction, placeholder, "No results found.");

    const queue = getOrCreateQueue(interaction, voiceChannel);
    const result = enqueue(queue, songs, playlistName, { next });

    let payload;
    switch (result.kind) {
        case "duplicate":
            payload = `**${result.song.title}** is already in the queue at position #${result.position}.`;
            break;
        case "single":
            log.music(
                `Enqueued ${log.bold(result.song.title)} ${log.gray(`by ${interaction.user.tag}`)}`,
            );
            // A track that starts immediately needs no card of its own: the
            // live Now Playing panel posts itself the moment audio starts, and a
            // second copy here would go stale as soon as the track changed.
            // Caller-only, so it doesn't push that panel up the channel — unless
            // a placeholder already claimed the interaction publicly, in which
            // case ephemeral is no longer available.
            // Caller-only, like the Starting ack: the live panel is the public
            // artifact, and a public card per added track pushes it up the
            // channel. Ephemeral is only possible while the interaction is
            // unclaimed — a placeholder already went out publicly and an edit
            // cannot take it private.
            payload = result.isFirst
                ? starting(`▶️ Starting **${result.song.title}**…`, placeholder)
                : componentPayload(queuedView(result.song, result.position, queue, { next }), {
                    ephemeral: !placeholder,
                });
            break;
        case "many":
            payload = {
                embeds: [playlistQueued(result.count, result.playlistName, interaction.user.tag, next)],
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
}

// Ephemeral can only be decided when the interaction is first answered: once a
// placeholder has gone out publicly, editReply cannot make it caller-only.
const starting = (content, placeholder) => (placeholder ? content : ephemeral(content));

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
