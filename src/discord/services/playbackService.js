import { joinVoiceChannel } from "@discordjs/voice";

import { GuildQueue } from "@/discord/guildQueue.js";
import { attachPanel, clearPanel, refreshPanel } from "@/discord/services/nowPlayingService.js";
import { radioFrom, radioSongs } from "@/discord/services/radioService.js";
import { LIMITS } from "@/lib/constants.js";
import { UserFacingError } from "@/lib/errors.js";
import { log } from "@/lib/logger.js";

// Owns the live queues: one GuildQueue per active guild, plus the bot presence
// that reflects them. `GuildQueue` (discord/guildQueue.js) is an entity, not a
// service — it holds one guild's state and reports back here through callbacks —
// so the registry lives with the service that manages its lifecycle.
export const queues = new Map();

let _client = null;
export function setClient(client) {
    _client = client;
}

// Every state change does two things: the bot's presence, and the live Now
// Playing panel. Bundled so a caller can never refresh one and forget the other.
function onQueueChange(queue) {
    updateActivity();
    refreshPanel(queue).catch((err) => log.warn(`[queue ${queue.guildId}] panel: ${err.message}`));
}

function updateActivity() {
    if (!_client) return;
    const active = [...queues.values()].find((q) => q.playing && q.current);
    if (active) {
        _client.user?.setActivity(active.current.title, { type: 2 }); // 2 = Listening
    } else {
        _client.user?.setActivity(null);
    }
}

// Where to announce a track the queue had to drop. Kept up to date on every
// command that touches the queue, so the message lands in the channel the music
// is actually being requested from rather than wherever the queue was created.
const announceChannels = new Map();

// A dropped track has to say so: `/play` posts its Now Playing embed at queue
// time, so a failure that stays quiet looks like a bot playing silence. Written
// here rather than in GuildQueue because it is the discord-facing half — the
// entity only reports that a track died.
function announceDrop(guildId, song, err) {
    const channel = announceChannels.get(guildId);
    if (!channel) return;
    const title = song?.title ?? "that track";
    const reason = err instanceof UserFacingError ? err.message : "it wouldn't start";
    channel.send(`⚠️ Skipped **${title}** — ${reason}.`).catch((sendErr) => {
        // A channel we can't post in is not worth a Sentry issue.
        log.warn(`[queue ${guildId}] could not announce a dropped track: ${sendErr.message}`);
    });
}

// Get the guild's queue, creating it and joining the voice channel if needed.
export function getOrCreateQueue(interaction, voiceChannel) {
    announceChannels.set(interaction.guildId, interaction.channel);
    let queue = queues.get(interaction.guildId);
    // The panel follows the channel the music is being asked for, same as the
    // dropped-track announcements above.
    if (queue) {
        attachPanel(queue, interaction.channel);
        return queue;
    }

    queue = new GuildQueue(interaction.guildId, {
        onDestroy: () => {
            queues.delete(interaction.guildId);
            announceChannels.delete(interaction.guildId);
            clearPanel(interaction.guildId).catch(() => {});
        },
        onChange: () => onQueueChange(queue),
        onTrackError: (song, err) => announceDrop(interaction.guildId, song, err),
        onRefill: (q) => void refillStation(q),
    });
    queues.set(interaction.guildId, queue);
    attachPanel(queue, interaction.channel);
    queue.setConnection(joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
    }));
    return queue;
}

// Keep an active station stocked. Lives here rather than in GuildQueue because it
// is the discovery half — the entity only knows it is running low. Never throws:
// a station that dies on a bad refill would take the listening session with it.
async function refillStation(queue) {
    const station = queue.station;
    if (!station) return void queue.refillDone();
    try {
        // Alternate between the origin and the newest track. Neither alone works:
        // a fixed seed has ~50 candidates total, so the exclude set covers them all
        // within a handful of refills and the station starves — but pure drift
        // walks off the map. Measured over 12 refills from one seed, drifting
        // reached Eminem on one run and Filipino ballads on another; alternating
        // stayed on Soft Cell, Human League and Kim Carnes, still 60/60 unique.
        // Half the refills re-asking the origin is what keeps "radio of this song"
        // true an hour in.
        station.refills += 1;
        const seed = station.refills % 2 === 1 ? station.origin : station.drift;
        const tracks = await radioFrom([seed], {
            limit: LIMITS.RADIO_REFILL,
            exclude: station.exclude,
        });

        // Destroyed while we were awaiting (/stop, everyone left) — the queue is
        // gone, so adding to it would resurrect a dead session.
        if (queues.get(queue.guildId) !== queue || !queue.station) return;

        if (!tracks.length) {
            station.failures += 1;
            log.warn(
                `[radio ${queue.guildId}] empty refill ${station.failures}/${LIMITS.RADIO_MAX_FAILURES}`,
            );
            // Bounded on purpose. An unbounded retry is how a YouTube-side outage
            // turns one station into a permanent hot loop against a dead API.
            if (station.failures >= LIMITS.RADIO_MAX_FAILURES) {
                queue.stopStation();
                announce(queue.guildId, "📡 Radio ran out of suggestions — station stopped.");
            }
            return;
        }

        station.failures = 0;
        for (const track of tracks) station.exclude.add(track.id);
        const songs = radioSongs(tracks, station.requestedBy, station.requestedById);
        station.drift = { id: tracks.at(-1).id, title: tracks.at(-1).title };
        queue.addMany(songs);
        log.music(
            log.gray(`[radio] +${songs.length} · refill ${station.refills} via ${seed.title}`),
        );
    } catch (err) {
        log.error(`[radio ${queue.guildId}] refill: ${err.message}`);
    } finally {
        queue.refillDone();
    }
}

// Plain message into the channel the music is being requested from. Same channel
// map announceDrop uses, and the same rule: a failed send must never propagate.
function announce(guildId, content) {
    announceChannels.get(guildId)?.send(content).catch((err) => {
        log.warn(`[queue ${guildId}] could not announce: ${err.message}`);
    });
}

// Add resolved songs to the queue. Returns a tagged result the command renders:
//   { kind: "duplicate", song, position }   single track already queued
//   { kind: "single",    song, isFirst, position }
//   { kind: "many",      count, playlistName }
// `next` puts them at the front of the wait list instead of the tail (/playnow).
export function enqueue(queue, songs, playlistName, { next = false } = {}) {
    if (songs.length === 1) {
        const song = songs[0];
        // Only dedup on a real URL — Spotify tracks carry url=null until resolved.
        const dupePos = song.url ? queue.songs.findIndex((s) => s.url === song.url) : -1;
        if (dupePos >= 0) return { kind: "duplicate", song, position: dupePos + 1 };

        let index;
        if (next) {
            index = queue.addNext([song]);
        } else {
            index = queue.songs.length;
            queue.add(song);
        }
        return { kind: "single", song, isFirst: index === 0, position: index + 1 };
    }

    if (next) queue.addNext(songs);
    else queue.addMany(songs);
    return { kind: "many", count: songs.length, playlistName };
}
