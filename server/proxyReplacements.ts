import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
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

function fileIdentity(info: Stats) {
    if (!info.isFile() || info.nlink !== 1) throw new Error('Proxy operation requires a regular file with a single link.');
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

export async function regularIdentity(path: string) {
    try {
        return fileIdentity(await lstat(path));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function proxyDigest(path: string, expected: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        if (fileIdentity(await file.stat()) !== expected) throw new Error('Proxy changed before verification.');
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ highWaterMark: 1024 * 1024, autoClose: false })) hash.update(chunk);
        if (await regularIdentity(path) !== expected) throw new Error('Proxy changed during verification.');
        return hash.digest('hex');
    } finally { await file.close(); }
}

export async function verifyPublishedProxy(target: string, transferred: string, local: { path: string; identity: string; bytes: number }) {
    const published = await regularIdentity(target);
    if (!published || Number(published.split(':')[2]) !== local.bytes) throw new Error('Published proxy is missing or its size changed.');
    if (renamedFileKey(published) !== renamedFileKey(transferred)) {
        // A share may report different attributes through the final name. Verify the actual proxy bytes in that case.
        const expected = await proxyDigest(local.path, local.identity);
        if (await proxyDigest(target, published) !== expected) throw new Error('Published proxy contents differ from the verified Cache copy.');
    }
    return published;
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
