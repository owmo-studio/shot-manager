// Synthetic MP4s only. Exercise the encoder and probe the actual MOV timecode track.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const execute = require('node:util').promisify(require('node:child_process').execFile);

const signal = new AbortController().signal;
const shot = { metadata: { color: {} } };
const rate = '30000/1001';

async function streams(path) {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]);
    return JSON.parse(stdout).streams;
}

async function source(path, frames, options = [], frameRate = rate) {
    await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=64x48:rate=${frameRate}`,
        ...options, '-frames:v', String(frames), '-c:v', 'libx264', path]);
}

function ltcXml(value, fps = 30, halfStep = false) {
    // A later entry first ensures the table lookup uses frameCount, not array order.
    const xml = Buffer.from(`<NonRealTimeMeta><Device manufacturer="Sony"/>
        <VideoFormat><VideoFrame captureFps="119.88p"/></VideoFormat>
        <LtcChangeTable tcFps="${fps}" halfStep="${halfStep}">
        <LtcChange frameCount="20" value="00000000"/><LtcChange frameCount="0" value="${value}"/>
        </LtcChangeTable></NonRealTimeMeta>`);
    const header = Buffer.alloc(12);
    header.writeUInt32BE(header.length + xml.length);
    header.write('xml ', 4);
    return Buffer.concat([header, xml]);
}

async function sonySource(root, name, frames, seconds, value) {
    const path = join(root, name + '.mp4');
    // Use a timed text sample to make a properly indexed MP4 packet. Change its handler,
    // sample type and payload in place to model Sony's rtmd stream without camera footage.
    const marker = 'synthetic metadata packet';
    const subtitle = join(root, name + '.srt');
    await fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\n' + marker + '\n');
    await source(path, frames, ['-i', subtitle, '-map', '0:v', '-map', '1:s', '-c:s', 'mov_text']);
    const bytes = await fs.readFile(path);
    for (const [from, to] of [['sbtl', 'meta'], ['tx3g', 'rtmd']]) {
        const offset = bytes.indexOf(from);
        assert.ok(offset >= 0 && offset === bytes.lastIndexOf(from));
        bytes.write(to, offset);
    }
    const offset = bytes.indexOf(marker);
    assert.ok(offset >= 0);
    bytes.fill(0, offset, offset + marker.length);
    // RTMD hh, mm, ss, drop, ff at packet offset 13 (the sample has a two-byte length prefix).
    Buffer.from([7, 20, seconds, 0, 29]).copy(bytes, offset + 11);
    await fs.writeFile(path, Buffer.concat([bytes, ltcXml(value)]));
    return path;
}

(async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'shot-manager-proxy-timecode-'));
    try {
        const entry = join(root, 'entry.ts');
        await fs.writeFile(entry, ['proxies', 'proxyTiming'].map(file =>
            `export * from ${JSON.stringify(join(__dirname, '..', 'server', file + '.ts'))};`).join('\n'));
        const { build } = await import('vite');
        const bundle = await build({ configFile: false, logLevel: 'silent', build: {
            ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } },
        } });
        const loaded = new (require('node:module'))(__filename, module);
        loaded.paths = module.paths;
        loaded._compile(bundle.output.find(chunk => chunk.isEntry).code, __filename);
        const { encodeProxy, sourceProxyTiming, verifyProxyTiming } = loaded.exports;
        async function check(input, label, frames, frameRate) {
            const output = input + '.partial';
            await encodeProxy(input, output, shot, signal, () => {});
            const media = await streams(output);
            const video = media.find(s => s.codec_type === 'video');
            const tracks = media.filter(s => s.codec_tag_string === 'tmcd');
            assert.equal(tracks.length, label ? 1 : 0);
            assert.equal(tracks[0]?.tags?.timecode, label);
            assert.equal(video.tags?.timecode, label);
            assert.equal(Number(video.nb_frames), frames);
            if (frameRate) assert.equal(video.avg_frame_rate, frameRate);
            return output;
        }

        for (const [name, frames, seconds, packed] of [
            ['0251', 270, 49, '69492007'], ['0252', 435, 58, '69582007'],
        ]) {
            const path = await sonySource(root, name, frames, seconds, packed);
            const input = await streams(path);
            assert.ok(!input.some(s => s.codec_tag_string === 'tmcd'));
            const rtmd = input.find(s => s.codec_tag_string === 'rtmd');
            assert.ok(rtmd);
            // Older FFprobe builds do not expose an rtmd start label.
            if (rtmd.tags?.timecode) assert.equal(rtmd.tags.timecode, `07:20:${seconds}:29`);
            await check(path, `07:20:${seconds};29`, frames, rate);
        }
        for (const [name, label, frameRate] of [
            ['df', '07:20:58;29', rate], ['ndf', '07:20:58:29', rate],
            ['24fps', '01:02:03:04', '24/1'], ['untagged', undefined, rate],
        ]) {
            const path = join(root, name + '.mp4');
            await source(path, 40, label ? ['-timecode', label] : [], frameRate);
            await check(path, label, 40, frameRate);
        }
        const formatTagged = join(root, 'format-tag.mkv');
        await source(formatTagged, 40, ['-metadata', 'timecode=01:02:03:04'], '25/1');
        await check(formatTagged, '01:02:03:04', 40, '25/1');
        const fragmented = join(root, 'fragmented.mp4');
        await source(fragmented, 40, ['-bf', '0', '-movflags', 'empty_moov+frag_keyframe'], '60/1');
        await check(fragmented, undefined, 40, '60/1');
        const fragmentTiming = await sourceProxyTiming(fragmented, signal);
        await assert.rejects(verifyProxyTiming(join(root, 'untagged.mp4.partial'), fragmentTiming, signal), /frame rate/);

        const expected = await sourceProxyTiming(join(root, '0252.mp4'), signal);
        await assert.rejects(verifyProxyTiming(join(root, 'ndf.mp4.partial'), expected, signal), /timecode verification/);
        await assert.rejects(verifyProxyTiming(join(root, 'df.mp4.partial'), expected, signal), /frame count/);
        await assert.rejects(verifyProxyTiming(join(root, 'df.mp4.partial'), { ...expected, constantRate: '30/1' }, signal), /frame rate/);
        const conflicting = join(root, 'ndf.mp4');
        await fs.appendFile(conflicting, ltcXml('69582007'));
        await assert.rejects(sourceProxyTiming(conflicting, signal), /Conflicting source timecodes/);
        const wrongStart = await sonySource(root, 'wrong-start', 40, 49, '69582007');
        await assert.rejects(encodeProxy(wrongStart, wrongStart + '.partial', shot, signal, () => {}), /Conflicting source timecodes/);

        const paired = join(root, 'paired.mp4');
        await source(paired, 20, [], '60000/1001');
        await fs.appendFile(paired, ltcXml('69D82007', 30, true));
        await check(paired, '07:20:58;59', 20, '60000/1001');

        const variable = join(root, 'variable.mp4');
        await source(variable, 20, ['-vf', "setpts='N+floor(N/3)'", '-fps_mode', 'vfr', '-bf', '0']);
        const variableOutput = await check(variable, undefined, 20);
        async function timestamps(path) {
            const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
                'packet=pts_time', '-of', 'csv=p=0', path]);
            return stdout.trim().split('\n').map(Number);
        }
        const originalPts = await timestamps(variable);
        assert.ok(originalPts[3] - originalPts[2] > 0.06);
        assert.deepEqual(await timestamps(variableOutput), originalPts);
        console.log('PASS: Sony LTC and rtmd, standard DF/NDF, untagged and VFR sources, and pre-publication timing checks.');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
