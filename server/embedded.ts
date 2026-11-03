import { open } from "node:fs/promises";
import { extname } from "node:path";

export interface EmbeddedTrack {
    id?: number;
    handler?: string;
    timeScale?: number;
    timing?: { samples: number; minimumDelta: number; maximumDelta: number };
    logProfiles: string[];
}

export interface EmbeddedContainer {
    xml: string[];
    tracks: EmbeddedTrack[];
    warnings: string[];
}

const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "edts", "dinf"]);
const visualEntries = new Set(["avc1", "avc3", "hvc1", "hev1", "dvh1", "dvhe", "apch", "apcn", "apcs", "apco", "ap4h", "ap4x", "mp4v", "av01", "vp09"]);

export async function readEmbeddedContainer(path: string, signal?: AbortSignal): Promise<EmbeddedContainer> {
    const result: EmbeddedContainer = { xml: [], tracks: [], warnings: [] };
    if (![".mp4", ".mov", ".m4v"].includes(extname(path).toLowerCase())) return result;
    const file = await open(path, "r");
    let readBytes = 0;
    let boxes = 0;
    try {
        const info = await file.stat();
        async function read(position: number, length: number) {
            signal?.throwIfAborted();
            if (length < 0 || position < 0 || position + length > info.size || readBytes + length > 8 * 1024 * 1024) throw new Error("Embedded metadata exceeds safe read limits.");
            const bytes = Buffer.alloc(length);
            let total = 0;
            while (total < length) {
                const next = await file.read(bytes, total, length - total, position + total);
                if (!next.bytesRead) throw new Error("Embedded metadata was truncated.");
                total += next.bytesRead;
            }
            readBytes += length;
            return bytes;
        }
        async function walk(start: number, end: number, depth: number, track?: EmbeddedTrack) {
            if (depth > 12) throw new Error("Embedded metadata nesting exceeds safe limits.");
            let position = start;
            while (position + 8 <= end) {
                if (++boxes > 20000) throw new Error("Embedded metadata contains too many boxes.");
                const header = await read(position, 8);
                let size = header.readUInt32BE(0);
                const type = header.toString("latin1", 4, 8);
                let headerSize = 8;
                if (size === 1) {
                    const extended = (await read(position + 8, 8)).readBigUInt64BE();
                    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid metadata box size.");
                    size = Number(extended);
                    headerSize = 16;
                } else if (size === 0) size = end - position;
                if (size < headerSize || position + size > end) throw new Error("Invalid embedded metadata box bounds.");
                const payload = position + headerSize;
                const length = size - headerSize;
                if (type === "trak") {
                    const next: EmbeddedTrack = { logProfiles: [] };
                    result.tracks.push(next);
                    await walk(payload, position + size, depth + 1, next);
                } else if (containers.has(type)) {
                    const legacyMeta = type === "meta" && length >= 8 && (await read(payload + 4, 4)).toString("latin1") === "hdlr";
                    await walk(payload + (type === "meta" && !legacyMeta ? 4 : 0), position + size, depth + 1, track);
                } else if (type === "stsd" && length >= 8) {
                    await walk(payload + 8, position + size, depth + 1, track);
                } else if (visualEntries.has(type) && length >= 78) {
                    await walk(payload + 78, position + size, depth + 1, track);
                } else if (type === "xml " && length <= 1024 * 1024) {
                    const text = (await read(payload, length)).toString("utf8").replace(/^\0{0,4}/, "").replace(/\0+$/, "").trim();
                    if (text) result.xml.push(text);
                } else if (type === "logs" && track && length <= 4096) {
                    track.logProfiles.push((await read(payload, length)).toString("utf8").replace(/\0+$/, ""));
                } else if (type === "hdlr" && track && length >= 12) {
                    if (!track.handler) track.handler = (await read(payload + 8, 4)).toString("latin1");
                } else if ((type === "tkhd" || type === "mdhd") && track && length >= 16) {
                    const version = (await read(payload, 1))[0];
                    const offset = version === 0 ? 12 : version === 1 ? 20 : -1;
                    if (offset >= 0 && length >= offset + 4) {
                        const value = (await read(payload + offset, 4)).readUInt32BE();
                        if (type === "tkhd") track.id = value;
                        else track.timeScale = value;
                    }
                } else if (type === "stts" && track && length >= 8) {
                    const count = (await read(payload + 4, 4)).readUInt32BE();
                    if (8 + count * 8 > length) throw new Error("Invalid frame timing table bounds.");
                    if (count > 500000 || readBytes + count * 8 > 7 * 1024 * 1024) {
                        result.warnings.push("Frame timing table exceeds the inspection limit; timing mode is unknown.");
                        position += size;
                        continue;
                    }
                    const entries = await read(payload + 8, count * 8);
                    let samples = 0, minimumDelta = Infinity, maximumDelta = 0;
                    for (let i = 0; i < count; i++) {
                        const number = entries.readUInt32BE(i * 8);
                        const delta = entries.readUInt32BE(i * 8 + 4);
                        if (!number || !delta) continue;
                        samples += number;
                        minimumDelta = Math.min(minimumDelta, delta);
                        maximumDelta = Math.max(maximumDelta, delta);
                    }
                    if (samples > 1) track.timing = { samples, minimumDelta, maximumDelta };
                }
                position += size;
            }
        }
        await walk(0, info.size, 0);
    } catch (error) {
        signal?.throwIfAborted();
        result.warnings.push(error instanceof Error && !('code' in error) ? error.message : "Some embedded container metadata could not be read.");
    } finally { await file.close(); }
    return result;
}
