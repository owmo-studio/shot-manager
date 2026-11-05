import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, readdir, realpath, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readSmallFile } from "./discovery";
import { commonFingerprintMetadata, VideoFingerprintStore } from "./fingerprints";
import type { FingerprintMetadata } from "./fingerprints";
import type { VideoMetadata } from "../shared/shots";
import { viewingProfile } from "../shared/viewing";
import { loadViewingLut, viewingLutPath } from "./viewing";

const execute = promisify(execFile);
const maximumImageBytes = 2 * 1024 * 1024;
export const DEFAULT_THUMBNAIL_CACHE_EXPIRY_DAYS = 90;
const cacheFilename = /^[a-f0-9]{64}(?:\.jpg|\.[a-f0-9-]{36}\.tmp)$/;

export async function inspectThumbnailCache(directory: string, clear = false) {
    const summary = { bytes: 0, files: 0 };
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return summary;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !cacheFilename.test(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
            const info = await lstat(path);
            if (!info.isFile()) continue;
            if (clear) await unlink(path);
            else { summary.bytes += info.size; summary.files += 1; }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return summary;
}

export async function pruneThumbnailCache(cacheDirectory: string, expiryDays = DEFAULT_THUMBNAIL_CACHE_EXPIRY_DAYS, now = Date.now()) {
    if (!Number.isFinite(expiryDays) || expiryDays <= 0) throw new Error("Cache expiry must be a positive number of days");
    const cutoff = now - expiryDays * 24 * 60 * 60 * 1000;
    const result = { removed: 0, failed: 0 };
    let entries;
    try {
        entries = await readdir(cacheDirectory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}(?:\.jpg|\.[a-f0-9-]{36}\.tmp)$/.test(entry.name)) continue;
        const path = join(cacheDirectory, entry.name);
        try {
            const info = await lstat(path);
            if (!info.isFile() || info.mtimeMs > cutoff) continue;
            await unlink(path);
            result.removed += 1;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failed += 1;
        }
    }
    return result;
}

export function isJpeg(bytes: Buffer): boolean {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
        bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function fileIdentity(info: Stats): string {
    return `${info.dev}:${info.ino}:${info.birthtimeMs}:${info.size}:${info.mtimeMs}`;
}

export class ThumbnailQueue {
    private pending: Promise<void> = Promise.resolve();
    private shutdown = new AbortController();
    private cacheDirectory: string;
    private legacyLocations = new Map<string, { input: string; sourceIdentity: string }[]>();

    constructor(cacheDirectory: string, private fingerprints = new VideoFingerprintStore()) {
        this.cacheDirectory = cacheDirectory;
    }

    async clearCache() {
        this.shutdown.abort();
        await this.pending;
        this.legacyLocations.clear();
        try { return await inspectThumbnailCache(this.cacheDirectory, true); }
        finally { this.shutdown = new AbortController(); }
    }

    cacheSummary() { return inspectThumbnailCache(this.cacheDirectory); }

    async touch(input: string, sourceIdentity: string, metadata?: VideoMetadata, fingerprintMetadata?: FingerprintMetadata) {
        const paths = await this.cachePaths(input, sourceIdentity, metadata, this.shutdown.signal, fingerprintMetadata);
        const now = new Date();
        for (const path of [paths.custom, paths.generated, ...paths.legacyCustom, ...paths.legacyGenerated]) {
            try { if ((await lstat(path)).isFile()) await utimes(path, now, now); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
    }

    rememberLegacyLocation(identity: string, input: string, sourceIdentity: string) {
        const locations = this.legacyLocations.get(identity) ?? [];
        if (!locations.some((location) => location.input === input && location.sourceIdentity === sourceIdentity)) {
            locations.push({ input, sourceIdentity });
            this.legacyLocations.set(identity, locations.slice(-8));
        }
        if (this.legacyLocations.size > 1024) this.legacyLocations.delete(this.legacyLocations.keys().next().value!);
    }

    private async cachePaths(input: string, sourceIdentity: string, metadata: VideoMetadata | undefined, signal: AbortSignal, fingerprintMetadata?: FingerprintMetadata) {
        const info = await stat(input);
        if (!info.isFile()) throw new Error("Original video is unavailable.");
        const fingerprint = await this.fingerprints.identify(input, fingerprintMetadata ?? commonFingerprintMetadata(metadata), signal);
        const digest = fingerprint.value;
        const profile = metadata ? viewingProfile(metadata) : null;
        const transform = profile ? (await loadViewingLut(profile)).fingerprint : "passthrough";
        const filename = (key: string) => join(this.cacheDirectory, `${createHash("sha256").update(key).digest("hex")}.jpg`);
        const identity = fileIdentity(info);
        const legacy = [{ input, sourceIdentity }, ...(this.legacyLocations.get(identity) ?? [])];
        return {
            identity,
            fingerprint,
            ctimeMs: info.ctimeMs,
            custom: filename(`custom-preview-rec709-sampled-v4:${transform}:${digest}`),
            generated: filename(`first-frame-rec709-sampled-v4:${transform}:480x270:${digest}`),
            legacyCustom: legacy.map((location) => filename(`custom-preview-rec709-v2:${transform}:${location.sourceIdentity}:${location.input}:${identity}`)),
            legacyGenerated: legacy.map((location) => filename(`first-frame-rec709-v2:${transform}:480x270:${location.sourceIdentity}:${location.input}:${identity}`)),
        };
    }

    private async cachedImage(path: string, legacy: string[]) {
        for (const candidate of [path, ...legacy]) {
            try {
                const bytes = await readSmallFile(candidate, maximumImageBytes);
                if (!isJpeg(bytes)) continue;
                // Promote old cache entries without replacing an existing content-based capture.
                if (candidate !== path) await link(candidate, path).catch(() => undefined);
                return bytes;
            } catch {}
        }
        return null;
    }

    private async customPath(input: string, sourceIdentity: string, metadata?: VideoMetadata, fingerprintMetadata?: FingerprintMetadata) {
        return (await this.cachePaths(input, sourceIdentity, metadata, this.shutdown.signal, fingerprintMetadata)).custom;
    }

    async customImage(input: string, sourceIdentity: string, metadata?: VideoMetadata, fingerprintMetadata?: FingerprintMetadata): Promise<string | null> {
        try {
            const paths = await this.cachePaths(input, sourceIdentity, metadata, this.shutdown.signal, fingerprintMetadata);
            const bytes = await this.cachedImage(paths.custom, paths.legacyCustom);
            const current = await stat(input);
            if (fileIdentity(current) !== paths.identity || current.ctimeMs !== paths.ctimeMs) return null;
            return bytes ? `data:image/jpeg;base64,${bytes.toString("base64")}` : null;
        } catch { return null; }
    }

    async setCustomImage(input: string, sourceIdentity: string, dataUrl: string, validate: () => Promise<boolean>, metadata?: VideoMetadata, fingerprintMetadata?: FingerprintMetadata) {
        const path = await this.customPath(input, sourceIdentity, metadata, fingerprintMetadata);
        if (!await validate()) throw new Error("Source changed while updating the thumbnail.");
        const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
        const bytes = match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
        if (bytes.length > maximumImageBytes || !isJpeg(bytes)) throw Object.assign(new Error("Invalid thumbnail image."), { statusCode: 400 });
        await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
        const temporaryPath = path.replace(/\.jpg$/, `.${randomUUID()}.tmp`);
        try {
            await writeFile(temporaryPath, bytes, { mode: 0o600, flush: true });
            if (!await validate() || await this.customPath(input, sourceIdentity, metadata, fingerprintMetadata) !== path) throw new Error("Source changed while saving the thumbnail.");
            await rename(temporaryPath, path);
        } finally { await unlink(temporaryPath).catch(() => undefined); }
    }

    enqueue(inputs: string[], sourceIdentity: string, signal: AbortSignal, validate: () => Promise<boolean>, completed: (image: string | null) => void, metadata?: VideoMetadata, fingerprintMetadata?: FingerprintMetadata) {
        const combinedSignal = AbortSignal.any([signal, this.shutdown.signal]);
        this.pending = this.pending.then(async () => {
            let image: string | null = null;
            try {
                for (const input of inputs) {
                    combinedSignal.throwIfAborted();
                    if (!await validate()) break;
                    try {
                        image = await this.extract(input, sourceIdentity, combinedSignal, validate, metadata, fingerprintMetadata);
                        if (image) break;
                    } catch {
                        combinedSignal.throwIfAborted();
                    }
                }
            } catch {
                image = null;
            }
            if (!combinedSignal.aborted) completed(image);
        }).catch(() => undefined);
    }

    private async extract(input: string, sourceIdentity: string, signal: AbortSignal, validate: () => Promise<boolean>, metadata?: VideoMetadata, fingerprintMetadata?: FingerprintMetadata): Promise<string | null> {
        if (await realpath(input) !== input) return null;
        const paths = await this.cachePaths(input, sourceIdentity, metadata, signal, fingerprintMetadata);
        const identity = paths.identity;
        const profile = metadata ? viewingProfile(metadata) : null;
        const cachedPath = paths.generated;
        const cached = await this.cachedImage(paths.custom, paths.legacyCustom) ?? await this.cachedImage(cachedPath, paths.legacyGenerated);
        signal.throwIfAborted();
        const current = await stat(input);
        if (fileIdentity(current) !== identity || current.ctimeMs !== paths.ctimeMs) return null;
        if (cached && await validate()) return `data:image/jpeg;base64,${cached.toString("base64")}`;

        // Escape filter-language characters; execFile still receives an argument array.
        const lutPath = profile ? viewingLutPath(profile).replace(/[\\':,;\[\]]/g, "\\$&") : null;
        const matrix = metadata?.color.matrix === "bt2020nc" ? "bt2020" : "bt709";
        const range = metadata?.color.range === "pc" ? "full" : metadata?.color.range === "tv" ? "limited" : "auto";
        const filters = lutPath ? [
            `scale=iw:ih:in_color_matrix=${matrix}:in_range=${range}:out_range=full`,
            "format=gbrpf32le", `lut3d=file='${lutPath}':interp=trilinear`,
            "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=full",
        ] : [];
        filters.push("scale=480:270:force_original_aspect_ratio=decrease:force_divisible_by=2");
        const { stdout } = await execute("ffmpeg", [
            "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-i", input,
            "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-filter_threads", "1",
            "-vf", filters.join(","),
            "-threads", "1", "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
        ], { encoding: "buffer", timeout: 12000, killSignal: "SIGKILL", maxBuffer: maximumImageBytes, signal });
        signal.throwIfAborted();
        if (!isJpeg(stdout) || fileIdentity(await stat(input)) !== identity || !await validate()) return null;

        let temporaryPath: string | undefined;
        try {
            await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
            temporaryPath = cachedPath.replace(/\.jpg$/, `.${randomUUID()}.tmp`);
            await writeFile(temporaryPath, stdout, { mode: 0o600, flush: true });
            signal.throwIfAborted();
            if (!await validate()) return null;
            await rename(temporaryPath, cachedPath);
        } catch {
            signal.throwIfAborted();
        } finally {
            if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
        }
        return `data:image/jpeg;base64,${stdout.toString("base64")}`;
    }

    async close() {
        this.shutdown.abort();
        await this.pending;
    }
}
