import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { libraryFileIdentity, within } from './library';
import { VIDEO_SAMPLE_BYTES, VIDEO_SAMPLE_SCHEME, videoSampleRanges } from './fingerprints';

const exportDirectories = ['Proxy'] as const;
export const exportMetadataFilename = '_metadata.csv';
export type ExportDirectories = Record<typeof exportDirectories[number], string | null>;
export function exportPath(root: string, name: string) {
    if (name.includes('\0') || isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !within(root, resolve(root, name))) throw new Error('Invalid export filename.');
    return join(root, name);
}
async function directoryIdentity(path: string) {
    try {
        const info = await lstat(path, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export folders must be real directories, without symlinks.');
        return `${info.dev}:${info.ino}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function inspectExportDirectories(root: string): Promise<ExportDirectories> {
    return Object.fromEntries(await Promise.all(exportDirectories.map(async name => [name, await directoryIdentity(join(root, name))]))) as ExportDirectories;
}
export async function checkExportDirectories(root: string, expected: ExportDirectories, create = false, beforeCreate?: () => Promise<void>) {
    for (const name of exportDirectories) {
        const path = join(root, name);
        let identity = await directoryIdentity(path);
        if (expected[name] && identity !== expected[name]) throw new Error('Export folder changed. Review Export again.');
        if (!identity && create) {
            await beforeCreate?.();
            try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            identity = await directoryIdentity(path);
        }
        if (create && !identity) throw new Error('Export folder is unavailable.');
        if (identity) expected[name] = identity;
    }
}
export async function exportFileIdentity(path: string) {
    const identity = await libraryFileIdentity(path);
    if (identity && (await lstat(path)).nlink !== 1) throw new Error('Destination is a linked file. Choose another destination.');
    return identity;
}
export async function readExportDocument(root: string, name: string) {
    const path = exportPath(root, name), identity = await exportFileIdentity(path);
    if (!identity) return { identity, content: undefined };
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024 ||
            [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') !== identity) throw new Error('Invalid export metadata file.');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile());
        if (await exportFileIdentity(path) !== identity) throw new Error('Export metadata changed while reading.');
        return { identity, content };
    } catch (cause) { throw new Error('Existing export metadata could not be read. The file has been preserved.', { cause }); }
    finally { await file.close(); }
}
export async function readExportOwner(path: string) {
    // Match the app's sampled clip ID; this is filename ownership, not transfer verification.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid exported source.');
        const identity = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
        const ranges = videoSampleRanges(info.size);
        const hash = createHash('sha256').update(JSON.stringify({ scheme: VIDEO_SAMPLE_SCHEME, fileSize: info.size, ranges }));
        const bytes = Buffer.alloc(VIDEO_SAMPLE_BYTES);
        for (const range of ranges) {
            let consumed = 0;
            while (consumed < range.length) {
                const next = await file.read(bytes, 0, Math.min(bytes.length, range.length - consumed), range.offset + consumed);
                if (!next.bytesRead) throw new Error('Exported source was truncated.');
                hash.update(bytes.subarray(0, next.bytesRead));
                consumed += next.bytesRead;
            }
        }
        if (identity !== await libraryFileIdentity(path)) throw new Error('Exported source changed while reading.');
        return hash.digest('hex');
    } catch (cause) { throw new Error('Existing exported source is unreadable. It has been preserved.', { cause }); }
    finally { await file.close(); }
}
export async function publishExportFile(root: string, name: string, content: string, expected: string | null, signal: AbortSignal,
    guard: () => Promise<void>) {
    const path = exportPath(root, name), staging = join(dirname(path), `.${randomUUID()}.partial`);
    let created = false;
    try {
        signal.throwIfAborted(); await guard();
        const file = await open(staging, 'wx', 0o600); created = true;
        try { await file.writeFile(content, 'utf8'); } finally { await file.close(); }
        await guard(); signal.throwIfAborted();
        if (await exportFileIdentity(path) !== expected) throw new Error('Export file changed after review. Review Export again.');
        await rename(staging, path); created = false;
        return await exportFileIdentity(path);
    } finally {
        // Never follow a replaced parent when cleaning up a staging file.
        if (created) { try { await guard(); await unlink(staging); } catch { /* Ignore safely orphaned partials. */ } }
    }
}
