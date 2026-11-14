import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { libraryFileIdentity, within } from './library';

export type ExportDirectories = Record<'Proxy' | 'Metadata' | 'Manifest', string | null>;
export function exportPath(root: string, name: string) {
    if (name.includes('\0') || isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !within(root, resolve(root, name))) throw new Error('Invalid export filename.');
    return join(root, name);
}
async function directoryIdentity(path: string) {
    try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export folders must be real directories, without symlinks.');
        return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function inspectExportDirectories(root: string): Promise<ExportDirectories> {
    return Object.fromEntries(await Promise.all(['Proxy', 'Metadata', 'Manifest'].map(async name => [name, await directoryIdentity(join(root, name))]))) as ExportDirectories;
}
export async function checkExportDirectories(root: string, expected: ExportDirectories, create = false, beforeCreate?: () => Promise<void>) {
    for (const name of ['Proxy', 'Metadata', 'Manifest'] as const) {
        const path = join(root, name);
        let identity = await directoryIdentity(path);
        if (expected[name] && identity !== expected[name]) throw new Error('Export folder changed. Review Sync again.');
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
export async function readExportOwner(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 1024 * 1024 || info.nlink !== 1) throw new Error('Invalid exported metadata.');
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        let length = 0;
        while (length < bytes.length) {
            const next = await file.read(bytes, length, bytes.length - length, length);
            if (!next.bytesRead) break;
            length += next.bytesRead;
        }
        if (length > 1024 * 1024 || [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') !== await libraryFileIdentity(path)) throw new Error('Export metadata changed while reading.');
        const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
        if (!value || !/^[a-f0-9]{64}$/.test(value.id) || value.fingerprint?.value !== value.id) throw new Error('Invalid exported metadata.');
        return value.id as string;
    } catch (cause) { throw new Error('Existing export metadata is unreadable. It has been preserved.', { cause }); }
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
        if (await exportFileIdentity(path) !== expected) throw new Error('Export file changed after review. Review Sync again.');
        await rename(staging, path); created = false;
        return await exportFileIdentity(path);
    } finally {
        // Never follow a replaced parent when cleaning up a staging file.
        if (created) { try { await guard(); await unlink(staging); } catch { /* Ignore safely orphaned partials. */ } }
    }
}

export function exportBatchFilename(date = new Date()) {
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
    return `Manifest/${stamp}_${randomUUID().slice(0, 8)}.csv`;
}
