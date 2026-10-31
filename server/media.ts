import type { FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

export async function sendVideo(request: FastifyRequest, reply: FastifyReply, file: FileHandle, path: string) {
    try {
        const info = await file.stat();
        const size = info.size;
        if (!info.isFile()) throw new Error("Not a regular file");
        const types: Record<string, string> = {
            ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
            ".webm": "video/webm", ".mkv": "video/x-matroska", ".mxf": "application/mxf",
            ".avi": "video/x-msvideo", ".mts": "video/mp2t", ".m2ts": "video/mp2t",
        };
        reply.type(types[extname(path).toLowerCase()] ?? "application/octet-stream");
        reply.header("Accept-Ranges", "bytes").header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
        let start = 0;
        let end = size - 1;
        const range = request.headers.range;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            let valid = !!match && !!(match[1] || match[2]) && size > 0;
            if (match && valid) {
                if (!match[1]) {
                    const suffix = Number(match[2]);
                    valid = Number.isSafeInteger(suffix) && suffix > 0;
                    start = Math.max(0, size - suffix);
                } else {
                    start = Number(match[1]);
                    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
                }
                valid = valid && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start;
            }
            if (!valid) {
                await file.close();
                return reply.code(416).header("Content-Range", `bytes */${size}`).header("Content-Length", "0").send();
            }
            reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        reply.header("Content-Length", size ? end - start + 1 : 0);
        if (!size) {
            await file.close();
            return reply.send();
        }
        return reply.send(file.createReadStream({ start, end, autoClose: true }));
    } catch (error) {
        await file.close().catch(() => undefined);
        throw error;
    }
}
