import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@discordjs/voice', () => {
    const player = {
        on: () => player,
        play: mock(() => {}),
        stop: mock(() => {}),
        pause: mock(() => {}),
        unpause: mock(() => {}),
    };
    return {
        createAudioPlayer: () => player,
        AudioPlayerStatus: { Idle: 'idle' },
        VoiceConnectionStatus: { Disconnected: 'disconnected' },
        entersState: mock(() => Promise.resolve()),
    };
});

mock.module('../../src/music/stream.js', () => ({
    createStream: mock(() => ({ _procs: [] })),
}));

mock.module('../../src/lib/db.js', () => ({
    saveSong: mock(() => {}),
    initDb: mock(() => Promise.resolve()),
    getHistory: mock(() => Promise.resolve([])),
}));

mock.module('../../src/lib/logger.js', () => ({
    log: { music: () => {}, info: () => {}, error: () => {}, cmd: () => {}, db: () => {}, bold: s => s, gray: s => s },
}));

const { GuildQueue } = await import('../../src/music/guildQueue.js');

const makeSong = (n = 1) => ({ title: `Song ${n}`, url: `https://yt.be/${n}`, duration: '3:00', requestedBy: 'user#0001', requestedById: '123' });

describe('GuildQueue', () => {
    let queue;
    let destroyed;

    beforeEach(() => {
        destroyed = false;
        queue = new GuildQueue('guild1', () => { destroyed = true; });
    });

    test('add enqueues song and sets playing', async () => {
        await queue.add(makeSong());
        expect(queue.songs).toHaveLength(1);
        expect(queue.playing).toBe(true);
    });

    test('current returns first song', async () => {
        await queue.add(makeSong(1));
        await queue.add(makeSong(2));
        expect(queue.current.title).toBe('Song 1');
    });

    test('stop clears songs and calls destroy', () => {
        queue.songs = [makeSong(1), makeSong(2)];
        queue.stop();
        expect(queue.songs).toHaveLength(0);
        expect(queue.playing).toBe(false);
        expect(destroyed).toBe(true);
    });

    test('addMany enqueues multiple songs', () => {
        queue.addMany([makeSong(1), makeSong(2), makeSong(3)]);
        expect(queue.songs).toHaveLength(3);
    });

    test('destroy calls onDestroy callback', () => {
        queue.destroy();
        expect(destroyed).toBe(true);
    });
});
