import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readEmbeddedContainer } from './embedded';
import { rational, sonyMetadata } from './videoMetadata';

const execute = promisify(execFile);
type Tags = Record<string, string>;
type Stream = {
    codec_type: string; codec_tag_string: string; id?: string; tags?: Tags;
    nb_frames?: string; r_frame_rate: string; avg_frame_rate: string;
};

async function probe(path: string, signal: AbortSignal) {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
        '-show_entries', 'stream=id,codec_type,codec_tag_string,nb_frames,r_frame_rate,avg_frame_rate:stream_tags=timecode:format_tags=timecode',
        '-of', 'json', '-i', path], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    const info: { streams: Stream[]; format?: { tags?: Tags } } = JSON.parse(stdout);
    const video = info.streams.find(stream => stream.codec_type === 'video'); // Same stream as -map 0:v:0.
    if (!video) throw new Error('Proxy timing check could not find a video stream.');
    return { video, streams: info.streams, tags: info.format?.tags };
}

function timecodeTag(tags?: Tags) {
    return Object.entries(tags ?? {}).find(([name]) => name.toLowerCase() === 'timecode')?.[1];
}

function sameRate(actual: string, expected: string) {
    const left = /^(\d+)\/(\d+)$/.exec(actual), right = /^(\d+)\/(\d+)$/.exec(expected);
    return !!left && !!right && BigInt(left[2]) > 0n && BigInt(right[2]) > 0n &&
        BigInt(left[1]) * BigInt(right[2]) === BigInt(right[1]) * BigInt(left[2]);
}

type LtcTable = NonNullable<ReturnType<typeof sonyMetadata>>['ltcTables'][number];

function sonyStart(table: LtcTable, playbackRate: number | null) {
    const { fps, halfStep, starts } = table;
    if (starts.length !== 1 || !starts[0] || !/^[\da-f]{8}$/i.test(starts[0])) {
        throw new Error('Sony LTC table has no unambiguous frame-zero timecode.');
    }
    const paired = halfStep === 'true';
    if ((halfStep !== 'false' && !paired) || !fps || !playbackRate || Math.round(playbackRate) !== fps * (paired ? 2 : 1)) {
        throw new Error('Sony LTC counting base does not match the video playback rate.');
    }
    const [ff, ss, mm, hh] = Buffer.from(starts[0], 'hex');
    const bcd = (byte: number, mask: number, max: number) => {
        const value = byte & mask;
        const decimal = (value >> 4) * 10 + (value & 15);
        if ((value & 15) > 9 || decimal > max) throw new Error('Invalid BCD in Sony frame-zero timecode.');
        return decimal;
    };
    const hours = bcd(hh, 0x3f, 23), minutes = bcd(mm, 0x7f, 59), seconds = bcd(ss, 0x7f, 59);
    let frames = bcd(ff, 0x3f, fps - 1);
    // SMPTE 12M counts frame pairs above 30 fps. At 50 fps the field bit is in the hours byte.
    if (paired) frames = frames * 2 + ((fps === 25 ? hh : ss) >> 7);
    const drop = (ff & 0x40) !== 0;
    if (drop && (fps !== 30 || playbackRate !== (paired ? 60000 : 30000) / 1001 ||
        (minutes % 10 !== 0 && seconds === 0 && frames < (paired ? 4 : 2)))) {
        throw new Error('Invalid drop-frame label or playback rate in Sony frame-zero timecode.');
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    return [hours, minutes, seconds].map(pad).join(':') + (drop ? ';' : ':') + pad(frames);
}

export async function sourceProxyTiming(path: string, signal: AbortSignal) {
    const { video, streams, tags } = await probe(path, signal);
    const embedded = await readEmbeddedContainer(path, signal);
    const track = embedded.tracks.find(item => item.handler === 'vide' && item.id === Number(video.id));
    const timing = track?.timing;
    // Some demuxers report the nominal rate as the average even for variable-rate material.
    const constantRate = timing && track.timeScale && timing.minimumDelta === timing.maximumDelta
        ? `${track.timeScale}/${timing.minimumDelta}` : undefined;
    const rate = rational(constantRate) ?? rational(video.r_frame_rate) ?? rational(video.avg_frame_rate);
    const cameraStarts = sonyMetadata(embedded)?.ltcTables.map(table => sonyStart(table, rate)) ?? [];
    const cameraStart = cameraStarts.at(0);
    const starts = new Set(cameraStarts);
    const rtmd = streams.filter(stream => stream.codec_tag_string === 'rtmd');
    const tmcd = streams.filter(stream => stream.codec_tag_string === 'tmcd');
    const addTag = (tag: string | undefined, sonyDisplay: boolean) => {
        if (!tag) return;
        // FFprobe can display the Sony rtmd digits with a colon even when the LTC drop bit is set.
        if (sonyDisplay && cameraStart?.includes(';') && tag === cameraStart.replace(';', ':')) return;
        starts.add(tag);
    };
    for (const stream of rtmd) {
        const tag = timecodeTag(stream.tags);
        if (!cameraStart && !tmcd.length && tag && !tag.includes(';') &&
            (rate === 30000 / 1001 || rate === 60000 / 1001)) {
            throw new Error('Sony timecode drop-frame mode could not be verified from embedded LTC.');
        }
        addTag(tag, true);
    }
    for (const stream of tmcd) addTag(timecodeTag(stream.tags), false);
    addTag(timecodeTag(video.tags), !tmcd.length);
    addTag(timecodeTag(tags), !tmcd.length);
    if (starts.size > 1) throw new Error(`Conflicting source timecodes: ${[...starts].join(', ')}.`);
    if (!starts.size && tmcd.length) throw new Error('Source timecode track has no readable start label.');
    return {
        timecode: starts.values().next().value,
        constantRate,
        reportedRate: !timing && rational(video.r_frame_rate) && sameRate(video.r_frame_rate, video.avg_frame_rate) ? video.r_frame_rate : undefined,
        frameCount: Number(video.nb_frames) > 0 ? Number(video.nb_frames) : undefined,
        variable: timing ? timing.minimumDelta !== timing.maximumDelta : video.avg_frame_rate !== video.r_frame_rate,
    };
}

export async function verifyProxyTiming(path: string, expected: Awaited<ReturnType<typeof sourceProxyTiming>>, signal: AbortSignal) {
    const { video, streams } = await probe(path, signal);
    const tracks = streams.filter(stream => stream.codec_tag_string === 'tmcd');
    if (tracks.length !== (expected.timecode ? 1 : 0) || timecodeTag(tracks[0]?.tags) !== expected.timecode ||
        timecodeTag(video.tags) !== expected.timecode) {
        throw new Error(`Proxy timecode verification failed (expected ${expected.timecode ?? 'untagged'}, found ${timecodeTag(tracks[0]?.tags) ?? 'no timecode track'}).`);
    }
    // Without a source sample table (e.g. fragmented MP4), compare the reported rate
    // when both files agree internally. VFR averages can differ from their nominal rates.
    const rate = expected.constantRate ?? (sameRate(video.r_frame_rate, video.avg_frame_rate) ? expected.reportedRate : undefined);
    if (rate && (!sameRate(video.r_frame_rate, rate) || !sameRate(video.avg_frame_rate, rate) ||
        (tracks.length && !sameRate(tracks[0].avg_frame_rate, rate)))) {
        throw new Error('Proxy frame rate differs from the source.');
    }
    if (expected.frameCount !== undefined && Number(video.nb_frames) !== expected.frameCount) {
        throw new Error(`Proxy frame count differs from the source (expected ${expected.frameCount}, found ${video.nb_frames ?? 'unknown'}).`);
    }
}
