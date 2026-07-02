import { describe, expect, mock, test } from 'bun:test';
import { StreamType } from '@discordjs/voice';

const spawned = [];

mock.module('child_process', () => ({
    spawn: mock((cmd, args) => {
        const proc = {
            cmd, args,
            stdout: { pipe: () => {}, on: () => {} },
            stderr: { on: () => {} },
            stdin: { on: () => {} },
            on: () => {},
        };
        spawned.push(proc);
        return proc;
    }),
}));

mock.module('@discordjs/voice', () => ({
    createAudioResource: mock((stream, opts) => ({ stream, inputType: opts.inputType, _procs: [] })),
    StreamType: { WebmOpus: 'webm/opus', Arbitrary: 'arbitrary', OggOpus: 'ogg/opus' },
}));

mock.module('youtubei.js', () => ({
    Innertube: { create: mock(async () => ({})) },
}));

const { createStream } = await import('../../src/music/stream.js');

describe('createStream', () => {
    test('no seek: uses WebmOpus, no ffmpeg', async () => {
        spawned.length = 0;
        const resource = await createStream('https://yt.be/abc');
        expect(resource.inputType).toBe(StreamType.WebmOpus);
        expect(spawned).toHaveLength(1);
        expect(spawned[0].cmd).toContain('yt-dlp');
    });

    test('no seek: requests webm format from yt-dlp', async () => {
        spawned.length = 0;
        await createStream('https://yt.be/abc');
        const fmt = spawned[0].args.find((_, i, a) => a[i - 1] === '-f');
        expect(fmt).toContain('webm');
    });

    test('seek: uses Arbitrary, spawns ffmpeg', async () => {
        spawned.length = 0;
        const resource = await createStream('https://yt.be/abc', 30);
        expect(resource.inputType).toBe(StreamType.Arbitrary);
        expect(spawned).toHaveLength(2);
        expect(spawned[1].cmd).toBe('ffmpeg');
    });

    test('seek: passes download-sections to yt-dlp', async () => {
        spawned.length = 0;
        await createStream('https://yt.be/abc', 60);
        expect(spawned[0].args).toContain('--download-sections');
        expect(spawned[0].args).toContain('*60-inf');
    });
});
