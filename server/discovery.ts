import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { DiscoveryRequest } from "../shared/shots";
import type { EmbeddedMetadata, VideoShot } from "../shared/shots";
import { findSonyLayout } from "./sony";
import { readEmbeddedContainer } from "./embedded";
import { normalizeVideoMetadata, sonyMetadata } from "./videoMetadata";
import { videoFileVersion } from "./fingerprints";

const execute = promisify(execFile);
const videoExtensions = new Set([".mp4", ".mov", ".mxf", ".m4v", ".mts", ".m2ts", ".avi", ".mkv", ".webm"]);

export function isVideoPath(path: string) { return videoExtensions.has(extname(path).toLowerCase()); }

export interface DiscoveredShot {
    shot: VideoShot;
    original: string;
    mediaInfo?: Record<string, unknown>;
    embeddedMetadata: EmbeddedMetadata[];
    fileIdentity: string;
}

export async function readSmallFile(path: string, limit: number): Promise<Buffer> {
    const file = await open(path, "r");
    try {
        if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
        const buffer = Buffer.alloc(limit + 1);
        let total = 0;
        while (total < buffer.length) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
            if (!bytesRead) break;
            total += bytesRead;
        }
        if (total > limit) throw new Error("File exceeds size limit");
        return buffer.subarray(0, total);
    } finally {
        await file.close();
    }
}

async function* candidates(source: DiscoveryRequest, signal: AbortSignal, warn: (message: string) => void): AsyncGenerator<string> {
    const pending = [source.path];
    while (pending.length) {
        signal.throwIfAborted();
        const directory = pending.pop()!;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) {
            if (directory === source.path) throw error;
            warn('Could not read folder ' + relative(source.path, directory) + '.');
            continue;
        }
        let layout: Awaited<ReturnType<typeof findSonyLayout>> = null;
        let sonyLayout = false;
        try {
            layout = entries.some((entry) => entry.isDirectory() && entry.name === "SUB") ? await findSonyLayout(directory) : null;
            if (layout) {
                const clips = await readdir(layout.clips, { withFileTypes: true });
                for (const clip of clips.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.toLowerCase().endsWith(".mp4")).slice(0, 8)) {
                    signal.throwIfAborted();
                    try {
                        if (sonyMetadata(await readEmbeddedContainer(join(layout.clips, clip.name), signal))) { sonyLayout = true; break; }
                    } catch { signal.throwIfAborted(); }
                }
            }
        } catch { signal.throwIfAborted(); warn('Could not inspect camera structure in ' + relative(source.path, directory) + '.'); }
        for (const entry of entries) {
            signal.throwIfAborted();
            if (entry.name.startsWith(".")) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (sonyLayout && layout && path === join(layout.root, "SUB")) continue;
                pending.push(path);
            } else if (entry.isFile() && isVideoPath(entry.name)) yield path;
        }
    }
}

export async function discoverShots(source: DiscoveryRequest, signal: AbortSignal, found: (result: DiscoveredShot) => void | Promise<void>, warn: (message: string) => void, files?: string[]): Promise<void> {
    for await (const original of files ?? candidates(source, signal, warn)) {
        signal.throwIfAborted();
        try {
            const info = await stat(original);
            const embedded = await readEmbeddedContainer(original, signal);
            const sony = sonyMetadata(embedded);
            if (sony?.proxy) continue;
            let mediaInfo: Record<string, unknown> | undefined;
            const warnings: string[] = [];
            try {
                const { stdout } = await execute("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_format", "-show_streams", "-of", "json", "-i", original], { timeout: 8000, maxBuffer: 1024 * 1024, signal });
                const parsed = JSON.parse(stdout);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid media metadata");
                mediaInfo = parsed;
            } catch {
                signal.throwIfAborted();
                warnings.push("Media metadata unavailable. The file may be unsupported, damaged, or FFprobe unavailable.");
            }
            const normalized = normalizeVideoMetadata(mediaInfo, embedded, sony);
            warnings.push(...embedded.warnings);
            if (mediaInfo && !normalized.hasVideo) warnings.push("No video stream was confirmed; inspect this file before committing.");
            const durationValue = (mediaInfo?.format as { duration?: unknown } | undefined)?.duration;
            const duration = durationValue === undefined ? NaN : Number(durationValue);
            const durationSeconds = Number.isFinite(duration) && duration >= 0 ? duration : null;
            const embeddedMetadata: EmbeddedMetadata[] = embedded.xml.map((xml, index) => ({ label: 'Embedded XML ' + (index + 1), format: "xml", text: xml }));
            if (embedded.tracks.length) embeddedMetadata.push({ label: "Embedded container declarations and timing", format: "json", text: JSON.stringify(embedded.tracks, null, 2) });
            if (mediaInfo) embeddedMetadata.push({ label: "Container and stream metadata", format: "json", text: JSON.stringify(mediaInfo, null, 2) });
            signal.throwIfAborted();
            const current = await stat(original);
            if (videoFileVersion(current) !== videoFileVersion(info)) {
                warn('File changed during scanning: ' + relative(source.path, original) + '. This file was skipped.');
                continue;
            }
            const relativePath = relative(source.path, original);
            await found({
                original, mediaInfo, embeddedMetadata,
                fileIdentity: videoFileVersion(info),
                shot: {
                    id: "", // Internal candidate; scanner assigns the fingerprint before publication.
                    filePath: original, filename: original.split("/").pop()!, relativePath, bytes: info.size,
                    timestamp: normalized.timestamp?.value ?? info.mtime.toISOString(),
                    dateSource: normalized.timestamp?.capture ? "camera" : normalized.timestamp ? "embedded" : "file-modified",
                    dateEvidence: normalized.timestamp?.source ?? "File modification time (capture time unknown)",
                    dateConfidence: normalized.timestamp?.capture && !normalized.timestamp.conflict ? "declared" : "uncertain",
                    cameraModel: normalized.metadata.device.model, metadata: normalized.metadata, durationSeconds,
                    hasThumbnail: false, warnings, available: true, editable: true,
                },
            });
        } catch (error) {
            signal.throwIfAborted();
            warn('Could not inspect ' + relative(source.path, original) + ' (' + ((error as NodeJS.ErrnoException).code ?? "read error") + ').');
        }
    }
}
