import { joinVoiceChannel } from "@discordjs/voice";

import { GuildQueue } from "@/discord/guildQueue.js";
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
    if (queue) return queue;

    queue = new GuildQueue(interaction.guildId, {
        onDestroy: () => {
            queues.delete(interaction.guildId);
            announceChannels.delete(interaction.guildId);
        },
        onChange: updateActivity,
        onTrackError: (song, err) => announceDrop(interaction.guildId, song, err),
    });
    queues.set(interaction.guildId, queue);
    queue.setConnection(joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
    }));
    return queue;
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
