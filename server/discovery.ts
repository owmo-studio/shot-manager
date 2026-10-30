import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { ImportSource } from "../shared/desktop";
import type { VideoShot } from "../shared/shots";

const execute = promisify(execFile);
const videoExtensions = new Set([".mp4", ".mov", ".mxf", ".m4v", ".mts", ".m2ts", ".avi", ".mkv", ".webm"]);
const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });

export interface ShotAssets {
    original: string;
    proxy?: string;
    thumbnail?: string;
    xml?: string;
}

export interface DiscoveredShot {
    shot: VideoShot;
    assets: ShotAssets;
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

async function directoryFiles(path: string, optional = false): Promise<Map<string, string>> {
    try {
        const entries = await readdir(path, { withFileTypes: true });
        return new Map(entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => [entry.name.toLowerCase(), join(path, entry.name)]));
    } catch (error) {
        if (optional && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return new Map();
        throw error;
    }
}

async function* candidates(source: ImportSource, signal: AbortSignal, warn: (message: string) => void): AsyncGenerator<ShotAssets> {
    if (source.type === "sony") {
        const root = join(source.path, "PRIVATE", "M4ROOT");
        const originals = await directoryFiles(join(root, "CLIP"));
        async function optionalFiles(path: string) {
            try { return await directoryFiles(path, true); }
            catch { warn(`Could not read optional assets in ${relative(source.path, path)}.`); return new Map<string, string>(); }
        }
        const proxies = await optionalFiles(join(root, "SUB"));
        const thumbnails = await optionalFiles(join(root, "THMBNL"));
        for (const path of originals.values()) {
            signal.throwIfAborted();
            if (!videoExtensions.has(extname(path).toLowerCase())) continue;
            const stem = basename(path, extname(path)).toLowerCase();
            yield {
                original: path,
                xml: originals.get(`${stem}m01.xml`),
                proxy: proxies.get(`${stem}s03.mp4`),
                thumbnail: thumbnails.get(`${stem}t01.jpg`),
            };
        }
        return;
    }
    const pending = [source.path];
    while (pending.length) {
        signal.throwIfAborted();
        const directory = pending.pop()!;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) {
            if (directory === source.path) throw error;
            warn(`Could not read folder ${relative(source.path, directory)}.`);
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) pending.push(path);
            else if (entry.isFile() && videoExtensions.has(extname(entry.name).toLowerCase())) yield { original: path };
        }
    }
}

function validTimestamp(value: unknown): string | null {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

export async function discoverShots(source: ImportSource, signal: AbortSignal, found: (result: DiscoveredShot) => void, warn: (message: string) => void): Promise<void> {
    for await (const assets of candidates(source, signal, warn)) {
        signal.throwIfAborted();
        try {
            const info = await stat(assets.original);
            const warnings: string[] = [];
            let timestamp: string | null = null;
            let dateSource: VideoShot["dateSource"] = "file-modified";
            let cameraModel: string | null = null;
            let durationSeconds: number | null = null;
            if (assets.xml) {
                try {
                    const xml = (await readSmallFile(assets.xml, 1024 * 1024)).toString("utf8");
                    if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid XML");
                    const metadata = xmlParser.parse(xml).NonRealTimeMeta;
                    timestamp = validTimestamp(metadata?.CreationDate?.["@_value"]);
                    if (timestamp) dateSource = "camera";
                    if (typeof metadata?.Device?.["@_modelName"] === "string") cameraModel = metadata.Device["@_modelName"];
                } catch { warnings.push("Camera XML could not be read; using available media metadata."); }
            }
            try {
                const { stdout } = await execute("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration:format_tags=creation_time:stream=codec_type:stream_tags=creation_time", "-of", "json", "-i", assets.original], { timeout: 8000, maxBuffer: 1024 * 1024, signal });
                const metadata = JSON.parse(stdout);
                const duration = Number(metadata.format?.duration);
                if (Number.isFinite(duration) && duration >= 0) durationSeconds = duration;
                if (!timestamp) {
                    timestamp = validTimestamp(metadata.format?.tags?.creation_time) ?? validTimestamp(metadata.streams?.find((stream: { codec_type?: string }) => stream.codec_type === "video")?.tags?.creation_time);
                    if (timestamp) dateSource = "embedded";
                }
                if (!metadata.streams?.some((stream: { codec_type?: string }) => stream.codec_type === "video")) warnings.push("No video stream was confirmed; inspect this file before ingestion.");
            } catch {
                signal.throwIfAborted();
                warnings.push("Media metadata unavailable. The file may be unsupported, damaged, or FFprobe unavailable.");
            }
            signal.throwIfAborted();
            const current = await stat(assets.original);
            if (current.size !== info.size || current.mtimeMs !== info.mtimeMs) {
                warn(`File changed during scanning: ${relative(source.path, assets.original)}. This file was skipped.`);
                continue;
            }
            const relativePath = relative(source.path, assets.original);
            found({ assets, shot: {
                id: createHash("sha256").update(`${source.id}\0${relativePath}`).digest("hex"),
                sourceId: source.id,
                filename: basename(assets.original),
                relativePath,
                bytes: info.size,
                timestamp: timestamp ?? info.mtime.toISOString(),
                dateSource,
                cameraModel,
                durationSeconds,
                hasProxy: !!assets.proxy,
                hasThumbnail: !!assets.thumbnail,
                hasXml: !!assets.xml,
                warnings,
                available: true,
                editable: true,
            } });
        } catch (error) {
            signal.throwIfAborted();
            warn(`Could not inspect ${relative(source.path, assets.original)} (${(error as NodeJS.ErrnoException).code ?? "read error"}).`);
        }
    }
}
