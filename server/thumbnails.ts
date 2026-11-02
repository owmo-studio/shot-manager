import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readSmallFile } from "./discovery";

const execute = promisify(execFile);
const maximumImageBytes = 2 * 1024 * 1024;
export const DEFAULT_THUMBNAIL_CACHE_EXPIRY_DAYS = 30;

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

    constructor(cacheDirectory: string) {
        this.cacheDirectory = cacheDirectory;
    }

    private async customPath(input: string, sourceIdentity: string) {
        const info = await stat(input);
        if (!info.isFile()) throw new Error("Original video is unavailable.");
        const key = createHash("sha256").update(`custom-preview-v1:${sourceIdentity}:${input}:${fileIdentity(info)}`).digest("hex");
        return join(this.cacheDirectory, `${key}.jpg`);
    }

    async customImage(input: string, sourceIdentity: string): Promise<string | null> {
        try {
            const bytes = await readSmallFile(await this.customPath(input, sourceIdentity), maximumImageBytes);
            return isJpeg(bytes) ? `data:image/jpeg;base64,${bytes.toString("base64")}` : null;
        } catch { return null; }
    }

    async setCustomImage(input: string, sourceIdentity: string, dataUrl: string | null, validate: () => Promise<boolean>) {
        const path = await this.customPath(input, sourceIdentity);
        if (!await validate()) throw new Error("Source changed while updating the thumbnail.");
        if (dataUrl === null) {
            try { await unlink(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            return;
        }
        const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
        const bytes = match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
        if (bytes.length > maximumImageBytes || !isJpeg(bytes)) throw Object.assign(new Error("Invalid thumbnail image."), { statusCode: 400 });
        await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
        const temporaryPath = path.replace(/\.jpg$/, `.${randomUUID()}.tmp`);
        try {
            await writeFile(temporaryPath, bytes, { mode: 0o600, flush: true });
            if (!await validate() || await this.customPath(input, sourceIdentity) !== path) throw new Error("Source changed while saving the thumbnail.");
            await rename(temporaryPath, path);
        } finally { await unlink(temporaryPath).catch(() => undefined); }
    }

    async cameraImage(input: string, sourceIdentity: string, signal: AbortSignal, validate: () => Promise<boolean>): Promise<string | null> {
        signal.throwIfAborted();
        if (await realpath(input) !== input || !await validate()) return null;
        const before = await stat(input);
        if (!before.isFile()) return null;
        const identity = fileIdentity(before);
        const key = createHash("sha256").update(`camera-image-v1:${sourceIdentity}:${input}:${identity}`).digest("hex");
        const cachedPath = join(this.cacheDirectory, `${key}.jpg`);
        try {
            const cached = await readSmallFile(cachedPath, maximumImageBytes);
            signal.throwIfAborted();
            if (isJpeg(cached) && await validate()) return `data:image/jpeg;base64,${cached.toString("base64")}`;
        } catch { signal.throwIfAborted(); }
        const bytes = await readSmallFile(input, maximumImageBytes);
        signal.throwIfAborted();
        if (!isJpeg(bytes) || fileIdentity(await stat(input)) !== identity || !await validate()) return null;
        let temporaryPath: string | undefined;
        try {
            await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
            temporaryPath = join(this.cacheDirectory, `${key}.${randomUUID()}.tmp`);
            await writeFile(temporaryPath, bytes, { mode: 0o600, flush: true });
            signal.throwIfAborted();
            if (!await validate()) return null;
            await rename(temporaryPath, cachedPath);
        } catch { signal.throwIfAborted(); }
        finally { if (temporaryPath) await unlink(temporaryPath).catch(() => undefined); }
        return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }

    enqueue(inputs: string[], sourceIdentity: string, signal: AbortSignal, validate: () => Promise<boolean>, completed: (image: string | null) => void) {
        const combinedSignal = AbortSignal.any([signal, this.shutdown.signal]);
        this.pending = this.pending.then(async () => {
            let image: string | null = null;
            try {
                for (const input of inputs) {
                    combinedSignal.throwIfAborted();
                    if (!await validate()) break;
                    try {
                        image = await this.extract(input, sourceIdentity, combinedSignal, validate);
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

    private async extract(input: string, sourceIdentity: string, signal: AbortSignal, validate: () => Promise<boolean>): Promise<string | null> {
        if (await realpath(input) !== input) return null;
        const before = await stat(input);
        if (!before.isFile()) return null;
        const identity = fileIdentity(before);
        const key = createHash("sha256").update(`first-frame-v1:480x270:${sourceIdentity}:${input}:${identity}`).digest("hex");
        const cachedPath = join(this.cacheDirectory, `${key}.jpg`);
        try {
            const cached = await readSmallFile(cachedPath, maximumImageBytes);
            if (isJpeg(cached) && await validate()) return `data:image/jpeg;base64,${cached.toString("base64")}`;
        } catch {}

        const { stdout } = await execute("ffmpeg", [
            "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-i", input,
            "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-filter_threads", "1",
            "-vf", "scale=480:270:force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-threads", "1", "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
        ], { encoding: "buffer", timeout: 12000, killSignal: "SIGKILL", maxBuffer: maximumImageBytes, signal });
        signal.throwIfAborted();
        if (!isJpeg(stdout) || fileIdentity(await stat(input)) !== identity || !await validate()) return null;

        let temporaryPath: string | undefined;
        try {
            await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
            temporaryPath = join(this.cacheDirectory, `${key}.${randomUUID()}.tmp`);
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
