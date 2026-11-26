import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { LibraryLocation } from './library';

// Store the bindings with the media so a verified encode survives a restart or catalogue rebuild.
// ctime changes on rename. Bind the local output to its inode, size and modification time.
const digest = (values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
export const replacementPattern = /^(?<id>[a-f0-9]{64})\.replacement(?<version>-v2)?\.(?<scope>[a-f0-9]{32})\.[a-f0-9]{32}\.[a-f0-9]{32}\.mov$/;
export interface StagedReplacement { name: string; legacyDevice?: string }
const withDevice = (identity: string, device: string) => device + identity.slice(identity.indexOf(':'));
const libraryKey = (location: LibraryLocation, device?: string) =>
    digest([location.path, location.mount, device === undefined ? location.identity : withDevice(location.identity, device)]);
export const renamedFileKey = (identity: string) => digest(identity.split(':').slice(0, 4));
// SMB assigns a device number per mount. Keep the directory inode, share and source
// attributes in the durable binding. Live operations still capture the full identities.
export function replacementName(id: string, library: LibraryLocation, source: string, sourceIdentity: string, localIdentity: string, legacyDevice?: string) {
    const device = library.mount.endsWith(':smbfs') ? legacyDevice ?? 'smb' : undefined;
    if (device !== undefined && sourceIdentity.split(':')[0] !== library.identity.split(':')[0]) throw new Error('The source is on a different volume from the Library.');
    const sourceKey = digest([source, device === undefined ? sourceIdentity : withDevice(sourceIdentity, device)]);
    return [id, device === 'smb' ? 'replacement-v2' : 'replacement', libraryKey(library, device), sourceKey, renamedFileKey(localIdentity), 'mov'].join('.');
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

async function legacySmbDevices(library: LibraryLocation, scopes: Set<string>) {
    const devices = new Map<string, string>();
    const current = library.identity.split(':')[0];
    const record = (device: string) => {
        const scope = libraryKey(library, device);
        if (scopes.delete(scope)) devices.set(scope, device);
    };
    record(current);
    // Older filenames hashed the device too. Darwin's vfs_getnewfsid assigns
    // SMB a 16-bit mount generation. Resolve each distinct hash once per scan,
    // still requiring an exact match for the share, path and directory inode.
    const base = Math.floor(Number(current) / 0x10000) * 0x10000;
    for (let generation = 1; scopes.size && generation <= 0xffff; generation++) {
        record(String(base + generation));
        if (generation % 2048 === 0) await setImmediate();
    }
    return devices;
}

export async function listReplacements(directory: string, library: LibraryLocation) {
    const result = new Map<string, StagedReplacement>();
    const files = (await readdir(directory, { withFileTypes: true })).flatMap(file => {
        const groups = replacementPattern.exec(file.name)?.groups;
        return groups ? [{ file, id: groups.id, scope: groups.scope, legacy: !groups.version }] : [];
    });
    const smb = library.mount.endsWith(':smbfs');
    const smbScope = smb ? libraryKey(library, 'smb') : undefined;
    const legacy = smb ? await legacySmbDevices(library, new Set(files.filter(item => item.legacy).map(item => item.scope))) :
        new Map([[libraryKey(library), undefined]]);
    for (const item of files) {
        if (item.legacy ? !legacy.has(item.scope) : item.scope !== smbScope) continue;
        if (!item.file.isFile() || result.has(item.id)) throw new Error('Conflicting or invalid staged proxies in Cache. Existing files have been preserved.');
        result.set(item.id, { name: item.file.name, legacyDevice: item.legacy ? legacy.get(item.scope) : undefined });
    }
    return result;
}

export async function checkReplacement(directory: string, staged: StagedReplacement, id: string, library: LibraryLocation, source: string, sourceIdentity: string) {
    const path = join(directory, staged.name);
    const identity = await regularIdentity(path);
    if (!identity) throw new Error('The staged proxy is missing.');
    if (staged.name !== replacementName(id, library, source, sourceIdentity, identity, staged.legacyDevice)) {
        throw new Error('The staged proxy or its Library source changed. Review the clip before re-encoding.');
    }
    return { path, identity, bytes: Number(identity.split(':')[2]) };
}
