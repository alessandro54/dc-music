import { AudioPlayerStatus, createAudioPlayer, entersState, VoiceConnectionStatus } from "@discordjs/voice";

import { attachPlayerEvents } from "@/discord/queuePlayerEvents.js";
import { hydrate } from "@/discord/resolvers/spotify.js";
import { createStream, destroyResource } from "@/discord/services/streamService.js";
import { getDjRank, saveSong } from "@/discord/services/trackService.js";
import { LIMITS, TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";
import { captureError } from "@/lib/sentry.js";
import { durationToMs } from "@/lib/utils.js";

// One guild's playback state machine: the song list, the audio player, the
// watchdogs. NOT a service — it owns per-guild state and there is one instance
// per active guild. The registry that holds those instances, and the Discord
// presence that reflects them, live in playbackService; this class reports
// upward through callbacks instead of reaching for module globals.
//
//   onDestroy() — the queue has torn itself down (drop it from the registry)
//   onChange()  — playback state changed (bot presence + the live Now Playing
//                 panel, which has to redraw the moment a track or the
//                 pause/resume state does, not on its next 10s tick)
//   onTrackError(song, err) — a track was dropped; say so where it was asked for
//   onRefill(queue) — the radio station is running low; go find more tracks
export class GuildQueue {
    constructor(guildId, { onDestroy, onChange, onTrackError, onRefill } = {}) {
        this.guildId = guildId;
        this._onDestroy = onDestroy;
        this._onChange = onChange;
        this._onTrackError = onTrackError;
        this._onRefill = onRefill;
        // An active /radio station: { origin, seed, exclude, failures, requestedBy,
        // requestedById }. Null when the queue is an ordinary playlist. It is
        // per-guild playback state, so it lives here and dies with the queue —
        // which is what makes /stop and the ⏹️ button turn the station off for
        // free, since stop() destroys.
        this.station = null;
        this._refilling = false;
        this.songs = [];
        // Tracks that have already finished or been skipped, newest last. Lives
        // only as long as the queue does — /history is the persistent record;
        // this is the in-memory undo behind /previous.
        this.played = [];
        this._replaying = false;
        this.connection = null;
        this.player = createAudioPlayer();
        this.playing = false;
        this._idleTimeout = null;
        this._stallTimeout = null;
        this._aloneTimeout = null;
        this.resource = null;
        this.seekOffset = 0;
        this._streamStartedAt = null;
        this._stallRetried = false;
        // The next track, extracted ahead of time: { song, resource } | null.
        // See _maybePrefetch for why this is allowed to overlap the live stream.
        this._next = null;
        this._prefetching = false;
        this._prefetchTimer = null;

        attachPlayerEvents(this);
    }

    // Play whatever is at the front, or wind down. `idleTimer` is the one
    // difference between running out of songs (start the leave countdown) and
    // failing out of them, where nothing armed one.
    _advance({ idleTimer = true } = {}) {
        // Before deciding anything: a station tops itself up. Deliberately not
        // special-cased below — the refill lands via addMany, which clears the
        // idle timer and starts playback if the queue drained first. So an empty
        // queue arming its 5-minute leave countdown is harmless: the tracks
        // arrive seconds later and cancel it.
        this._maybeRefill();
        if (this.songs.length > 0) return void this._playNext();
        this.playing = false;
        if (!idleTimer) return;
        this._onChange?.();
        log.music(`Queue empty in guild ${this.guildId}`);
        this._idleTimeout = setTimeout(() => this.destroy(), TIMEOUTS.QUEUE_IDLE_MS);
    }

    // Start an endless station from one seed. The first batch is the caller's
    // job; this is what keeps it going.
    startStation({ id, title, requestedBy, requestedById }) {
        this.station = {
            origin: { id, title }, // what the user asked for — half the refills re-ask it
            drift: { id, title }, // the newest track — the other half follow this
            refills: 0,
            exclude: new Set([id]),
            failures: 0,
            requestedBy,
            requestedById,
        };
    }

    stopStation() {
        this.station = null;
    }

    // Top up when the wait list runs short. The `_refilling` flag matters: every
    // track change calls _advance, so without it a slow refill would be started
    // several times over and queue three copies of the same batch.
    _maybeRefill() {
        if (!this.station || this._refilling) return;
        if (this.songs.length > LIMITS.RADIO_LOW_WATER) return;
        this._refilling = true;
        // The callback owns the awaiting; the flag is cleared by the caller
        // through `refillDone` so this stays synchronous.
        try {
            this._onRefill?.(this);
        } catch (err) {
            this._refilling = false;
            log.error(`[Queue ${this.guildId}] refill: ${err.message}`);
        }
    }

    refillDone() {
        this._refilling = false;
    }

    setConnection(connection) {
        this.connection = connection;
        connection.subscribe(this.player);
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(
                        connection,
                        VoiceConnectionStatus.Signalling,
                        TIMEOUTS.VOICE_RECONNECT_MS,
                    ),
                    entersState(
                        connection,
                        VoiceConnectionStatus.Connecting,
                        TIMEOUTS.VOICE_RECONNECT_MS,
                    ),
                ]);
            } catch {
                this.destroy();
            }
        });
        connection.on("error", (err) => log.error(`[VoiceConnection ${this.guildId}] ${err.message}`));
    }

    // Alone in the channel: leave after a grace period rather than immediately —
    // a client reconnect or a channel hop shows up as a brief empty channel, and
    // tearing the queue down for that loses the whole song list.
    markAlone() {
        if (this._aloneTimeout) return;
        this._aloneTimeout = setTimeout(() => {
            log.music(`Alone in guild ${this.guildId} — leaving`);
            this.destroy();
        }, TIMEOUTS.ALONE_LEAVE_MS);
    }

    markNotAlone() {
        clearTimeout(this._aloneTimeout);
        this._aloneTimeout = null;
    }

    get current() {
        return this.songs[0] ?? null;
    }

    get paused() {
        return this.player.state.status === AudioPlayerStatus.Paused;
    }

    _killStream() {
        const resource = this.resource;
        this.resource = null;
        // Reap in the background — callers stay synchronous, but the procs and
        // their stdio pipes are guaranteed to be cleaned up (SIGTERM→SIGKILL).
        destroyResource(resource).catch((err) => {
            log.error(`[Queue ${this.guildId}] killStream: ${err.message}`);
            captureError(err, { tags: { stage: "teardown", guild: this.guildId } });
        });
    }

    async add(song) {
        clearTimeout(this._idleTimeout);
        this.songs.push(song);
        this._absorbLookups(song);
        if (!this.playing) await this._playNext();
    }

    // The lookups the resolver refused to wait for — metadata (`_meta`) and
    // album art (`_artwork`) — ride on the song as promises that resolve to
    // VALUES: resolveQuery copies songs on their way in, so a resolver-side
    // mutation would land on an object this queue never sees. They are absorbed
    // here, into the queue's own copy, the moment they settle; each landing
    // fires onChange so the live panel redraws instead of waiting for its tick.
    // Wired into every add path, not into _start, so a track waiting deep in
    // the queue shows its real title in /queue too.
    _absorbLookups(song) {
        // The requester's DJ-leaderboard rank, shown on the panel's Added by
        // line. Stamped once per song, not per render — the panel redraws every
        // 10s and a Turso round-trip per tick would be absurd for a badge.
        if (song.djRank === undefined && song.requestedById) {
            song.djRank = null;
            getDjRank(this.guildId, song.requestedById).then((rank) => {
                if (!rank) return;
                song.djRank = rank;
                this._onChange?.();
            }).catch(() => {});
        }
        song._meta?.then((info) => {
            if (!info) return;
            song.title = info.title ?? song.title;
            song.duration ??= info.duration;
            this._onChange?.();
        });
        song._artwork?.then((art) => {
            if (!art || song.thumbnail === art) return;
            song.thumbnail = art;
            this._onChange?.();
        });
    }

    // Jump the queue: land right behind the playing track instead of at the tail.
    // songs[0] IS the playing track (the Idle handler shifts it off when it
    // ends), so index 1 is the front of what is actually waiting. With nothing
    // playing there is no such track and index 0 is that same spot. Returns the
    // index it landed at so the caller can report the position.
    addNext(songs) {
        clearTimeout(this._idleTimeout);
        const at = this.playing ? 1 : 0;
        this.songs.splice(at, 0, ...songs);
        for (const song of songs) this._absorbLookups(song);
        if (!this.playing) this._playNext();
        return at;
    }

    addMany(songs) {
        clearTimeout(this._idleTimeout);
        const wasEmpty = this.songs.length === 0;
        this.songs.push(...songs);
        for (const song of songs) this._absorbLookups(song);
        if (!this.playing && wasEmpty) this._playNext();
    }

    // Play the front of the queue. Two things can go wrong — the song may not be
    // playable yet (Spotify, resolved lazily) and the extraction may fail — and
    // both end the same way: drop the track, move on.
    async _playNext() {
        const queued = this.songs[0];
        if (!queued) return;

        let song = queued;
        if (song.spotifyTrack) {
            try {
                song = await hydrate(song);
                this.songs[0] = song;
            } catch (err) {
                return this._dropTrack(err, "resolve", {
                    title: song.title,
                    spotifyTrack: song.spotifyTrack?.name,
                });
            }
        }

        try {
            await this._start(song, this._takePrefetch(song));
        } catch (err) {
            return this._dropTrack(err, "stream", {
                title: song.title,
                url: song.url,
                requestedBy: song.requestedBy,
            });
        }
    }

    async _start(song, prefetched = null) {
        const started = performance.now();
        this._streamStartedAt = started;
        // The streaming extraction reports the duration for free — no second
        // yt-dlp needed for the track that's actually playing. A prefetched
        // track skips the extraction entirely: its resource already proved a
        // first byte while the previous track was still playing.
        const resource = prefetched ??
            await createStream(song.url, this.seekOffset, (duration) => {
                song.duration ??= duration;
            }, { transcode: song.transcode });
        this.resource = resource;
        this.player.play(resource);
        this.playing = true;
        // Watch the clock while something plays, so the track after this one
        // can be extracted before it is needed. ??= — one timer per queue.
        this._prefetchTimer ??= setInterval(
            () => void this._maybePrefetch(),
            TIMEOUTS.PREFETCH_CHECK_MS,
        );
        this._onChange?.();
        log.music(
            `${log.bold(song.title)} ${
                log.gray(
                    `· ${song.duration ?? "—"} · by ${song.requestedBy} · spawn ${
                        Math.round(performance.now() - started)
                    }ms${prefetched ? " · prefetched" : ""}`,
                )
            }`,
        );
        // History records the real title, so a song whose metadata is still in
        // flight (placeholder title) waits for it — the save was already
        // fire-and-forget, this only sequences it behind the lookup.
        (song._meta ?? Promise.resolve()).then(() =>
            saveSong({
                guildId: this.guildId,
                userId: song.requestedById,
                userTag: song.requestedBy,
                title: song.title,
                url: song.url,
                duration: song.duration,
                viaPlaylist: song.viaPlaylist,
                source: song.source,
            })
        );
    }

    // Extract the NEXT track while the current one still plays, so the gap
    // between songs is a player state flip instead of a ~7s cold extraction.
    //
    // This deliberately overlaps two yt-dlp processes, which the sequential-
    // playback rule exists to forbid — but the rule's reason is CPU contention
    // between two *extractions* (measured 6.9s of added latency on 2 cores).
    // Mid-track, the live process finished extracting long ago and is just
    // trickling bytes through a backpressured pipe at ~zero CPU; the overlap
    // here is extraction-beside-idle-pipe, not extraction-beside-extraction.
    //
    // Failures are logged and forgotten, never dropped: the normal play-time
    // path owns the drop and its announcement, and an extraction that failed
    // 25s early might still succeed when its turn comes.
    async _maybePrefetch() {
        if (!this.playing || this._next || this._prefetching || !this.resource) return;
        const upcoming = this.songs[1];
        if (!upcoming) return;
        const totalMs = durationToMs(this.current?.duration);
        if (!totalMs) return; // duration not known yet — the sidecar answers ~3s in
        const remaining = totalMs - (this.resource.playbackDuration + this.seekOffset * 1000);
        if (remaining <= 0 || remaining > TIMEOUTS.PREFETCH_LEAD_MS) return;

        this._prefetching = true;
        try {
            let song = upcoming;
            if (song.spotifyTrack) {
                song = await hydrate(song);
                // The queue may have been reordered during the await; only a
                // song still sitting at position 1 is worth extracting.
                if (this.songs[1] !== upcoming) return;
                this.songs[1] = song;
            }
            const resource = await createStream(song.url, 0, (duration) => {
                song.duration ??= duration;
            }, { transcode: song.transcode });
            // Same check after the long await: /playnow, /previous or a stop
            // may have moved the ground. An unwanted extraction is reaped, not
            // parked.
            if (this.songs[1] !== song || !this.playing) {
                destroyResource(resource).catch(() => {});
                return;
            }
            this._next = { song, resource };
            log.music(log.gray(`prefetched ${song.title}`));
        } catch (err) {
            log.warn(`[Queue ${this.guildId}] prefetch: ${err.message}`);
        } finally {
            this._prefetching = false;
        }
    }

    // Hand over the prefetched resource iff it is exactly the song about to
    // play. Identity, not url: the same video can sit in the queue twice, and
    // after a reorder (/previous, /playnow) the held extraction belongs to a
    // track that is no longer next — reaped rather than played out of order.
    _takePrefetch(song) {
        const next = this._next;
        if (!next) return null;
        this._next = null;
        if (next.song === song) return next.resource;
        destroyResource(next.resource).catch(() => {});
        return null;
    }

    _dropPrefetch() {
        const next = this._next;
        this._next = null;
        if (next) destroyResource(next.resource).catch(() => {});
    }

    // A track that could not be played: report it, drop it, keep the queue
    // moving. No idle timer — running out of songs this way is a failure, not
    // the end of a listening session.
    //
    // Telling the channel is not decoration. `/play` has already posted a Now
    // Playing embed by the time this runs — it is sent when the track is queued,
    // not when audio arrives — so without a message the failure looks like the
    // song is playing while nothing comes out, and `/np` answers "Nothing
    // playing". That is indistinguishable from a bot that has broken.
    _dropTrack(err, stage, extra) {
        log.error(`[Queue ${this.guildId}] ${stage}: ${err.message}`);
        captureError(err, { tags: { stage, guild: this.guildId }, extra });
        const [song] = this.songs.splice(0, 1);
        try {
            this._onTrackError?.(song, err);
        } catch (notifyErr) {
            // Never let the notification take the queue down with it.
            log.error(`[Queue ${this.guildId}] notify: ${notifyErr.message}`);
        }
        return this._advance({ idleTimer: false });
    }

    async seek(seconds) {
        if (!this.current?.url) return false;
        this._killStream();
        this.seekOffset = seconds;
        try {
            // seekSeconds > 0 already forces ffmpeg, so `transcode` is redundant
            // here — passed anyway so the flag has one meaning everywhere.
            const resource = await createStream(this.current.url, seconds, null, {
                transcode: this.current.transcode,
            });
            this.resource = resource;
            this.player.play(resource);
            this._onChange?.();
            return true;
        } catch (err) {
            log.error(`[Queue ${this.guildId}] Seek error: ${err.message}`);
            captureError(err, {
                tags: { stage: "seek", guild: this.guildId },
                extra: { title: this.current?.title, url: this.current?.url, seconds },
            });
            return false;
        }
    }

    skip() {
        this._killStream();
        this.seekOffset = 0;
        this.player.stop();
    }

    _remember(song) {
        this.played.push(song);
        if (this.played.length > LIMITS.PLAYED_HISTORY) this.played.shift();
    }

    // Go back one track. The current song is pushed back onto the front of the
    // queue rather than dropped, so previous → skip returns you to where you
    // were. Returns the track being replayed, or null when there is no history.
    previous() {
        const prev = this.played.pop();
        if (!prev) return null;
        this.songs.unshift(prev);
        // The held next-track extraction is now two positions away and would
        // sit on a proc for the whole replayed track — reap it now.
        this._dropPrefetch();
        this.seekOffset = 0;
        clearTimeout(this._idleTimeout);

        // Nothing is playing (the queue drained and we're inside the idle grace
        // period): stop() would emit no Idle event, so there is nothing to
        // interrupt and nothing to suppress — just start it.
        if (this.player.state.status === AudioPlayerStatus.Idle) {
            this._playNext();
            return prev;
        }

        // Interrupting the current track fires Idle, which would otherwise shift
        // `prev` straight back off the queue before it ever played.
        this._replaying = true;
        this._killStream();
        this.player.stop();
        return prev;
    }
    stop() {
        this.songs = [];
        this.playing = false;
        this._killStream();
        this.player.stop();
        this.destroy();
    }
    pause() {
        this.player.pause();
        this._onChange?.();
    }
    resume() {
        this.player.unpause();
        this._onChange?.();
    }

    destroy() {
        // The station goes with the queue: /stop and the ⏹️ button both land here,
        // and a station that outlived its queue would refill into nothing.
        this.station = null;
        clearTimeout(this._idleTimeout);
        clearTimeout(this._stallTimeout);
        clearTimeout(this._aloneTimeout);
        clearInterval(this._prefetchTimer);
        this._prefetchTimer = null;
        this._dropPrefetch();
        this._killStream();
        this.connection?.destroy();
        this.connection = null;
        this.playing = false;
        this._onDestroy?.();
    }
}
