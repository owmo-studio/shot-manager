import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VideoFingerprint, VideoMetadata } from '../shared/shots';

export const VIDEO_SAMPLE_BYTES = 256 * 1024;
export const VIDEO_SAMPLE_SCHEME = 'sampled-sha256-v1' as const;

export function commonFingerprintMetadata(metadata?: VideoMetadata, extra: {
    recordingDate?: string | null; durationSeconds?: number | null; frameCount?: string | null;
} = {}) {
    return {
        recordingDate: extra.recordingDate ?? null,
        durationSeconds: extra.durationSeconds ?? null,
        codec: metadata?.codec.name ?? null,
        width: metadata?.resolution.width ?? null,
        height: metadata?.resolution.height ?? null,
        frameRate: metadata?.frameRate.nominal ?? null,
        frameCount: extra.frameCount && /^\d+$/.test(extra.frameCount) ? extra.frameCount : null,
    };
}
export type FingerprintMetadata = ReturnType<typeof commonFingerprintMetadata>;

export function videoFileVersion(info: Stats) {
    return [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

export function videoSampleRanges(size: number) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid video size.');
    if (size <= VIDEO_SAMPLE_BYTES * 5) return [{ offset: 0, length: size }];
    return [0, .25, .5, .75, 1].map(fraction => ({
        offset: Math.round((size - VIDEO_SAMPLE_BYTES) * fraction), length: VIDEO_SAMPLE_BYTES,
    }));
}

// These records are lookup fingerprints, never full-file integrity checksums or UUIDs.
export class VideoFingerprintStore {
    private memory = new Map<string, VideoFingerprint>();
    constructor(private directory?: string) {}

    async identify(input: string, metadata: FingerprintMetadata, signal: AbortSignal): Promise<VideoFingerprint> {
        signal.throwIfAborted();
        const before = await stat(input);
        if (!before.isFile()) throw new Error('Not a regular video file.');
        const fileVersion = videoFileVersion(before);
        const serializedMetadata = JSON.stringify(metadata);
        const key = createHash('sha256').update(JSON.stringify([VIDEO_SAMPLE_SCHEME, fileVersion, metadata])).digest('hex');
        const memo = this.memory.get(key);
        if (memo) return { ...memo };
        const recordPath = this.directory ? join(this.directory, `${key}.json`) : null;
        const ranges = videoSampleRanges(before.size);
        const sampledBytes = ranges.reduce((sum, range) => sum + range.length, 0);
        if (recordPath) {
            try {
                const record = JSON.parse(await readFile(recordPath, 'utf8'));
                const fingerprint = record.fingerprint;
                if (record.version === 1 && record.fileVersion === fileVersion && JSON.stringify(record.metadata) === serializedMetadata &&
                    fingerprint?.scheme === VIDEO_SAMPLE_SCHEME && fingerprint.algorithm === 'sha256' &&
                    /^[a-f0-9]{64}$/.test(fingerprint.value) && fingerprint.fileSize === before.size &&
                    fingerprint.sampleBytes === VIDEO_SAMPLE_BYTES && fingerprint.sampledBytes === sampledBytes) {
                    signal.throwIfAborted();
                    if (videoFileVersion(await stat(input)) !== fileVersion) throw new Error('Video changed during fingerprint lookup.');
                    this.remember(key, fingerprint);
                    return { ...fingerprint };
                }
            } catch (error) { signal.throwIfAborted(); }
        }

        const hash = createHash('sha256');
        hash.update(JSON.stringify({ scheme: VIDEO_SAMPLE_SCHEME, fileSize: before.size, metadata, ranges }));
        const file = await open(input, 'r');
        try {
            if (videoFileVersion(await file.stat()) !== fileVersion) throw new Error('Video changed before fingerprinting.');
            const buffer = Buffer.alloc(VIDEO_SAMPLE_BYTES);
            for (const range of ranges) {
                let consumed = 0;
                while (consumed < range.length) {
                    signal.throwIfAborted();
                    const length = Math.min(buffer.length, range.length - consumed);
                    const { bytesRead } = await file.read(buffer, 0, length, range.offset + consumed);
                    if (!bytesRead) throw new Error('Video was truncated while fingerprinting.');
                    hash.update(buffer.subarray(0, bytesRead));
                    consumed += bytesRead;
                }
            }
            signal.throwIfAborted();
            if (videoFileVersion(await file.stat()) !== fileVersion || videoFileVersion(await stat(input)) !== fileVersion) {
                throw new Error('Video changed while fingerprinting.');
            }
        } finally { await file.close(); }
        const fingerprint: VideoFingerprint = {
            algorithm: 'sha256', scheme: VIDEO_SAMPLE_SCHEME, value: hash.digest('hex'),
            fileSize: before.size, sampleBytes: VIDEO_SAMPLE_BYTES, sampledBytes,
        };
        if (recordPath && this.directory) {
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            const temporary = `${recordPath}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify({ version: 1, fileVersion, metadata, fingerprint }) + '\n', { mode: 0o600, flush: true });
                signal.throwIfAborted();
                if (videoFileVersion(await stat(input)) !== fileVersion) throw new Error('Video changed before saving fingerprint.');
                await rename(temporary, recordPath);
            } finally { await unlink(temporary).catch(() => undefined); }
        }
        this.remember(key, fingerprint);
        return { ...fingerprint };
    }

    private remember(key: string, fingerprint: VideoFingerprint) {
        this.memory.set(key, { ...fingerprint });
        if (this.memory.size > 1024) this.memory.delete(this.memory.keys().next().value!);
    }
}
