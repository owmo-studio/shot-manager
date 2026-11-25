// Compare decoded patch interiors, so a metadata-only levels change cannot pass.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const execute = require('node:util').promisify(require('node:child_process').execFile);

const width = 128, height = 32, pixels = width * height;
const luma = [0, 64, 128, 256, 420, 640, 876, 1023];
const cb = [512, 300, 256, 400, 640, 448, 768, 512];
const cr = [512, 480, 672, 256, 400, 768, 350, 512];
const planes = [luma, cb, cr];
function patches(rgb) {
    const buffer = Buffer.alloc((rgb ? 3 : 2) * pixels * 2);
    let offset = 0;
    for (const [index, values] of planes.entries()) {
        const w = rgb || index === 0 ? width : width / 2;
        for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) {
            buffer.writeUInt16LE(values[Math.floor(x * values.length / w)], offset);
            offset += 2;
        }
    }
    return buffer;
}

(async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'shot-manager-proxy-color-'));
    try {
        const { build } = await import('vite');
        const bundle = await build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false,
            rollupOptions: { input: join(__dirname, '../server/proxies.ts'), output: { format: 'cjs' } } } });
        const loaded = new (require('node:module'))(__filename, module);
        loaded.paths = module.paths;
        loaded._compile(bundle.output.find(chunk => chunk.isEntry).code, __filename);
        for (const [name, primaries, transfer, matrix, range] of [
            ['rec709', 'bt709', 'bt709', 'bt709', 'tv'],
            ['linear', 'smpte432', 'linear', 'bt709', 'pc'],
            ['linear-rgb', 'bt709', 'linear', 'gbr', 'pc'],
            ['hlg', 'bt2020', 'arib-std-b67', 'bt2020nc', 'tv'],
            ['pq', 'bt2020', 'smpte2084', 'bt2020nc', 'tv'],
            ['sony', 'unknown', 'unknown', 'unknown', 'pc'],
            ['apple-log', 'bt2020', 'unknown', 'bt2020nc', 'pc'],
        ]) {
            const rgb = matrix === 'gbr', format = rgb ? 'gbrp10le' : 'yuv422p10le';
            const raw = join(root, name + '.raw'), input = join(root, name + (rgb ? '.mkv' : '.mp4')), output = input + '.mov';
            await fs.writeFile(raw, patches(rgb));
            // Some cameras declare Rec.709 in the bitstream alongside a more specific log capture profile.
            const inputTransfer = name === 'sony' || name === 'apple-log' ? 'bt709' : transfer;
            const inputPrimaries = name === 'sony' ? 'bt709' : primaries;
            await execute('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', format, '-video_size', width + 'x' + height,
                '-i', raw, '-vf', `setparams=range=${range}:colorspace=${matrix}:color_trc=${inputTransfer}:color_primaries=${inputPrimaries}`,
                '-frames:v', '1', ...(rgb ? ['-c:v', 'ffv1'] : ['-c:v', 'libx264', '-qp', '0']),
                '-color_range', range, '-color_primaries', inputPrimaries, '-color_trc', inputTransfer, '-colorspace', rgb ? 'rgb' : matrix,
                ...(name === 'apple-log' ? ['-metadata', 'com.apple.quicktime.colorSpace=apple_log', '-movflags', '+use_metadata_tags'] : []), input]);
            if (name === 'sony') {
                const xml = Buffer.from('<NonRealTimeMeta><Device manufacturer="Sony"/><AcquisitionRecord><Group>' +
                    '<Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="s-gamut3-cine"/>' +
                    '<Item name="CodingEquations" value="rec709"/></Group></AcquisitionRecord></NonRealTimeMeta>');
                const header = Buffer.alloc(12);
                header.writeUInt32BE(xml.length + 12); header.write('xml ', 4);
                await fs.appendFile(input, Buffer.concat([header, xml]));
            }
            await loaded.exports.encodeProxy(input, output, { durationSeconds: null }, new AbortController().signal, () => {});
            const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]);
            const probe = JSON.parse(stdout), video = probe.streams[0];
            assert.equal(video.color_range, 'tv', name);
            assert.equal(video.color_transfer ?? 'unknown', transfer, name);
            assert.equal(video.color_primaries ?? 'unknown', primaries, name);
            assert.equal(video.color_space, name === 'sony' || rgb ? 'bt709' : matrix, name);
            if (name === 'sony') {
                assert.equal(probe.format.tags.CaptureGammaEquation, 's-log3-cine');
                assert.equal(probe.format.tags.CaptureColorPrimaries, 's-gamut3-cine');
            }
            if (name === 'apple-log') assert.equal(probe.format.tags['com.apple.quicktime.colorSpace'], 'apple_log');
            const { stdout: decoded } = await execute('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '1',
                ...(rgb ? ['-vf', 'scale=in_range=tv:out_range=pc:in_color_matrix=bt709'] : []),
                '-pix_fmt', format, '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
            let offset = 0;
            for (const [channel, values] of planes.entries()) {
                const w = rgb || channel === 0 ? width : width / 2;
                for (const [i, value] of values.entries()) {
                    const x = (i + 0.5) * w / values.length;
                    const actual = decoded.readUInt16LE(2 * (offset + height / 2 * w + x));
                    let expected = value;
                    if (!rgb && range === 'pc') expected = channel === 0 ? 64 + value * 876 / 1023 : 512 + (value - 512) * 896 / 1023;
                    // ProRes reserves the extreme codes when encoding out-of-range limited input.
                    if (!rgb && range === 'tv') expected = Math.min(1019, Math.max(4, expected));
                    assert.ok(Math.abs(actual - expected) <= 5, `${name} channel ${channel}, patch ${i}: expected ${expected}, got ${actual}`);
                }
                offset += w * height;
            }
        }
        console.log('PASS: ProRes levels, gamma, gamut and decoded color patches across Rec.709, linear YUV/RGB, HLG, PQ, Sony and Apple Log.');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
