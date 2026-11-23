import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { libraryAssetName } from '../shared/library';
import { libraryFileIdentity } from './library';
import type { LibraryLocation } from './library';

export interface DeleteAsset { name: string; identity: string }
export interface OrphanAsset extends DeleteAsset { fingerprint: string }

const fingerprintedName = /^([a-f0-9]{64})\.(.+)$/;
// rsync stages transfers under the destination name with a leading dot and a random suffix.
const rsyncTemporaryName = /^\.([a-f0-9]{64})\.(?:source\.[a-z0-9]+|thumb\.jpg|proxy\.mov)\.(?:[a-zA-Z0-9]{6}|[a-zA-Z0-9]{10})$/;

// Include other tools' derived assets and partials, but never descend into folders
// (including NAS recycle folders) or follow an asset symlink.
export async function listDeleteAssets(location: LibraryLocation, ids: string[]) {
    const assets = new Map(ids.map(id => [id, [] as DeleteAsset[]]));
    for await (const entry of await opendir(location.path)) {
        const match = fingerprintedName.exec(entry.name);
        const selected = match && assets.get(match[1]);
        if (!selected) continue;
        const identity = await libraryFileIdentity(join(location.path, entry.name));
        if (!identity) throw new Error('Library files changed. Review Delete again.');
        selected.push({ name: entry.name, identity });
    }
    for (const files of assets.values()) files.sort((a, b) => a.name.localeCompare(b.name));
    return assets;
}

// A corrupt or non-regular publication marker still protects the clip's files.
export async function hasLibraryMetadata(location: LibraryLocation, fingerprint: string) {
    try {
        await lstat(join(location.path, libraryAssetName(fingerprint, 'metadata', 'json')));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

export async function listOrphanAssets(location: LibraryLocation, unlocked: (id: string) => boolean, signal: AbortSignal) {
    const names = new Map<string, string[]>();
    const published = new Set<string>();
    for await (const entry of await opendir(location.path)) {
        signal.throwIfAborted();
        const match = fingerprintedName.exec(entry.name) ?? rsyncTemporaryName.exec(entry.name);
        if (!match) continue;
        const [, fingerprint, suffix] = match;
        if (suffix === 'metadata.json') published.add(fingerprint);
        else if (entry.isFile()) {
            const files = names.get(fingerprint) ?? [];
            files.push(entry.name);
            names.set(fingerprint, files);
        }
    }
    const assets: OrphanAsset[] = [];
    for (const [fingerprint, files] of names) {
        signal.throwIfAborted();
        if (published.has(fingerprint) || !unlocked(fingerprint) || await hasLibraryMetadata(location, fingerprint)) continue;
        for (const name of files) {
            signal.throwIfAborted();
            const identity = await libraryFileIdentity(join(location.path, name));
            if (identity) assets.push({ fingerprint, name, identity });
        }
    }
    return assets.sort((a, b) => a.name.localeCompare(b.name));
}
