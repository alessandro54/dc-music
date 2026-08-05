import { AudioPlayerStatus, createAudioPlayer, entersState, VoiceConnectionStatus } from "@discordjs/voice";
import { TIMEOUTS } from "@/lib/constants.js";
import { saveSong } from "@/discord/services/trackService.js";
import { log } from "@/lib/logger.js";
import { captureError, captureWarn } from "@/lib/sentry.js";
import { searchVideo } from "@/discord/services/innertubeService.js";
import { createStream, destroyResource } from "@/discord/services/streamService.js";
import { forceDirectStreams } from "@/discord/services/ytdlpService.js";

// One guild's playback state machine: the song list, the audio player, the
// watchdogs. NOT a service — it owns per-guild state and there is one instance
// per active guild. The registry that holds those instances, and the Discord
// presence that reflects them, live in playbackService; this class reports
// upward through callbacks instead of reaching for module globals.
//
//   onDestroy() — the queue has torn itself down (drop it from the registry)
//   onChange()  — playing/stopped changed (refresh the bot's presence)
export class GuildQueue {
    constructor(guildId, { onDestroy, onChange } = {}) {
        this.guildId = guildId;
        this._onDestroy = onDestroy;
        this._onChange = onChange;
        this.songs = [];
        this.connection = null;
        this.player = createAudioPlayer();
        this.playing = false;
        this._idleTimeout = null;
        this._stallTimeout = null;
        this.resource = null;
        this.seekOffset = 0;
        this._streamStartedAt = null;
        this._stallRetried = false;

        // Stall watchdog: yt-dlp can be slow to first byte (or hang silently) on
        // a datacenter IP, leaving the player stuck in Buffering with no error and
        // no progress. If it buffers too long, skip to the next track.
        this.player.on(AudioPlayerStatus.Buffering, () => {
            clearTimeout(this._stallTimeout);
            this._stallTimeout = setTimeout(() => {
                // The fast path (proxy, no cookies) is ~95% reliable — measured
                // 18 of 19 — and a stream has no retry of its own, so the 1 in
                // 20 would die silently. Before giving up on the track, force
                // the slow-but-authenticated path and play it again. Only once:
                // a second stall is a genuinely bad track, not a flaky path.
                if (!this._stallRetried && forceDirectStreams()) {
                    this._stallRetried = true;
                    log.warn(
                        `[Queue ${this.guildId}] Stream stalled — retrying ${this.current?.title} with cookies`,
                    );
                    this._killStream();
                    this._playNext();
                    return;
                }
                log.error(
                    `[Queue ${this.guildId}] Stream stalled (buffering > ${TIMEOUTS.STREAM_STALL_MS}ms), skipping`,
                );
                captureWarn("Stream stalled while buffering", {
                    tags: { stage: "stall", guild: this.guildId },
                    extra: {
                        title: this.current?.title,
                        url: this.current?.url,
                        stallMs: TIMEOUTS.STREAM_STALL_MS,
                        retried: this._stallRetried,
                    },
                });
                this.player.stop(); // → Idle → advance
            }, TIMEOUTS.STREAM_STALL_MS);
        });
        this.player.on(AudioPlayerStatus.Playing, () => {
            clearTimeout(this._stallTimeout);
            // Time to first audio — the number the user actually waits through.
            // `spawn` only covers forking yt-dlp; the extraction that follows
            // (player JS, nsig, PO token, first bytes) is the real cost and was
            // previously invisible.
            this._stallRetried = false;
            if (this._streamStartedAt !== null) {
                log.music(log.gray(`audio in ${Math.round(performance.now() - this._streamStartedAt)}ms`));
                this._streamStartedAt = null;
            }
        });

        this.player.on(AudioPlayerStatus.Idle, () => {
            clearTimeout(this._stallTimeout);
            this._killStream();
            this.seekOffset = 0;
            this._stallRetried = false;
            this.songs.shift();
            if (this.songs.length > 0) {
                this._playNext();
            } else {
                this.playing = false;
                this._onChange?.();
                log.music(`Queue empty in guild ${this.guildId}`);
                this._idleTimeout = setTimeout(
                    () => this.destroy(),
                    TIMEOUTS.QUEUE_IDLE_MS,
                );
            }
        });

        this.player.on("error", (err) => {
            log.error(`[Queue ${this.guildId}] Player error: ${err.message}`);
            captureError(err, {
                tags: { stage: "player", guild: this.guildId },
                extra: { title: this.current?.title, url: this.current?.url },
            });
            this._killStream();
            this.songs.shift();
            if (this.songs.length > 0) this._playNext();
            else this.playing = false;
        });
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
        if (!this.playing) await this._playNext();
    }

    addMany(songs) {
        clearTimeout(this._idleTimeout);
        const wasEmpty = this.songs.length === 0;
        this.songs.push(...songs);
        if (!this.playing && wasEmpty) this._playNext();
    }

    async _playNext() {
        let song = this.songs[0];
        if (!song) return;

        if (song.spotifyTrack) {
            try {
                const { name, artists } = song.spotifyTrack;
                const info = await searchVideo(`${name} ${artists[0].name}`);
                song = {
                    ...song,
                    url: info.url,
                    title: info.title,
                    duration: info.duration,
                    spotifyTrack: null,
                };
                this.songs[0] = song;
            } catch (err) {
                log.error(
                    `[Queue ${this.guildId}] Could not resolve Spotify track: ${song.title}`,
                );
                captureError(err, {
                    tags: { stage: "resolve", guild: this.guildId },
                    extra: { title: song.title, spotifyTrack: song.spotifyTrack?.name },
                });
                this.songs.shift();
                if (this.songs.length > 0) await this._playNext();
                else this.playing = false;
                return;
            }
        }

        try {
            const started = performance.now();
            this._streamStartedAt = started;
            // The streaming extraction reports the duration for free — no second
            // yt-dlp needed for the track that's actually playing.
            const resource = await createStream(song.url, this.seekOffset, (duration) => {
                song.duration ??= duration;
            }, { transcode: song.transcode });
            this.resource = resource;
            this.player.play(resource);
            this.playing = true;
            this._onChange?.();
            log.music(
                `${log.bold(song.title)} ${
                    log.gray(
                        `· ${song.duration ?? "—"} · by ${song.requestedBy} · spawn ${
                            Math.round(performance.now() - started)
                        }ms`,
                    )
                }`,
            );
            saveSong({
                guildId: this.guildId,
                userId: song.requestedById,
                userTag: song.requestedBy,
                title: song.title,
                url: song.url,
                duration: song.duration,
                viaPlaylist: song.viaPlaylist,
                source: song.source,
            });
        } catch (err) {
            log.error(`[Queue ${this.guildId}] Stream: ${err.message}`);
            captureError(err, {
                tags: { stage: "stream", guild: this.guildId },
                extra: { title: song.title, url: song.url, requestedBy: song.requestedBy },
            });
            this.songs.shift();
            if (this.songs.length > 0) await this._playNext();
            else this.playing = false;
        }
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
    stop() {
        this.songs = [];
        this.playing = false;
        this._killStream();
        this.player.stop();
        this.destroy();
    }
    pause() {
        this.player.pause();
    }
    resume() {
        this.player.unpause();
    }

    destroy() {
        clearTimeout(this._idleTimeout);
        clearTimeout(this._stallTimeout);
        this._killStream();
        this.connection?.destroy();
        this.connection = null;
        this.playing = false;
        this._onDestroy?.();
    }
}
