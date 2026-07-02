import { describe, expect, mock, test } from 'bun:test';
import { PermissionFlagsBits } from 'discord.js';

mock.module('@discordjs/voice', () => ({
    joinVoiceChannel: mock(() => ({ subscribe: () => {}, on: () => {} })),
    createAudioPlayer: mock(() => ({ on: () => {}, play: () => {}, stop: () => {} })),
    AudioPlayerStatus: { Idle: 'idle' },
    VoiceConnectionStatus: { Disconnected: 'disconnected' },
    entersState: mock(() => Promise.resolve()),
}));

mock.module('../../src/music/guildQueue.js', () => ({
    queues: new Map(),
    GuildQueue: class {
        constructor() { this.songs = []; this.playing = false; }
        setConnection() {}
        async add() {}
        addMany() {}
    },
}));

mock.module('../../src/music/stream.js', () => ({
    getYoutubeInfo: mock(() => Promise.resolve({ title: 'Test Song', url: 'https://yt.be/1', duration: '3:00' })),
    createStream: mock(() => ({ _procs: [] })),
}));

mock.module('../../src/lib/logger.js', () => ({
    log: { music: () => {}, info: () => {}, error: () => {}, cmd: () => {}, db: () => {}, bold: s => s, gray: s => s },
}));

mock.module('../../src/lib/db.js', () => ({
    saveSong: mock(() => {}),
    getHistory: mock(() => Promise.resolve([])),
}));

mock.module('../../src/music/spotify.js', () => ({
    isSpotifyUrl: () => false,
    resolveSpotify: mock(() => Promise.resolve([])),
    getTrackMeta: mock(() => Promise.resolve(null)),
}));

const { default: playCmd } = await import('../../src/commands/play.js');

const makeInteraction = (overrides = {}) => ({
    deferReply: mock(() => Promise.resolve()),
    reply: mock(() => Promise.resolve()),
    editReply: mock(() => Promise.resolve()),
    guildId: 'guild1',
    user: { tag: 'user#0001', id: '123' },
    guild: { voiceAdapterCreator: {}, members: { me: {} } },
    options: { getString: () => 'test song' },
    member: { voice: { channel: null } },
    ...overrides,
});

describe('/play guards', () => {
    test('no voice channel → error reply', async () => {
        const i = makeInteraction();
        await playCmd.execute(i);
        expect(i.reply.mock.calls[0][0].content).toBe('Join a voice channel first.');
    });

    test('missing Connect permission → error reply', async () => {
        const i = makeInteraction({
            member: {
                voice: {
                    channel: {
                        id: 'vc1',
                        permissionsFor: () => ({ has: () => false }),
                    },
                },
            },
        });
        await playCmd.execute(i);
        expect(i.reply.mock.calls[0][0].content).toContain("don't have permission");
    });
});
