import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryLocation } from './library';

// Store the bindings with the media so a verified encode survives a restart or catalogue rebuild.
// ctime changes on rename. Bind the local output to its inode, size and modification time.
const digest = (values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
export const replacementPattern = /^([a-f0-9]{64})\.replacement\.([a-f0-9]{32})\.([a-f0-9]{32})\.([a-f0-9]{32})\.mov$/;
const libraryKey = (location: LibraryLocation) => digest([location.path, location.mount, location.identity]);
export const renamedFileKey = (identity: string) => digest(identity.split(':').slice(0, 4));
export function replacementName(id: string, library: LibraryLocation, source: string, sourceIdentity: string, localIdentity: string) {
    return [id, 'replacement', libraryKey(library), digest([source, sourceIdentity]), renamedFileKey(localIdentity), 'mov'].join('.');
}

export async function regularIdentity(path: string) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.nlink !== 1) throw new Error(`Proxy operation requires a regular file with a single link: ${path}`);
        return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

export async function listReplacements(directory: string, library: LibraryLocation) {
    const result = new Map<string, string>();
    const scope = libraryKey(library);
    for (const file of await readdir(directory, { withFileTypes: true })) {
        const match = replacementPattern.exec(file.name);
        if (!match || match[2] !== scope) continue;
        if (!file.isFile() || result.has(match[1])) throw new Error('Conflicting or invalid staged proxies in Cache. Existing files have been preserved.');
        result.set(match[1], file.name);
    }
    return result;
}

export async function checkReplacement(directory: string, name: string, id: string, library: LibraryLocation, source: string, sourceIdentity: string) {
    const path = join(directory, name);
    const identity = await regularIdentity(path);
    if (!identity || name !== replacementName(id, library, source, sourceIdentity, identity)) {
        throw new Error('The staged proxy or its Library source changed. Review the clip before re-encoding.');
    }
    return { path, identity, bytes: Number(identity.split(':')[2]) };
}
