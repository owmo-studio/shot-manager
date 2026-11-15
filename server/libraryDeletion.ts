import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { libraryFileIdentity } from './library';
import type { LibraryLocation } from './library';

export interface DeleteAsset { name: string; identity: string }

// Include other tools' derived assets and partials, but never descend into folders
// (including NAS recycle folders) or follow an asset symlink.
export async function listDeleteAssets(location: LibraryLocation, ids: string[]) {
    const assets = new Map(ids.map(id => [id, [] as DeleteAsset[]]));
    for await (const entry of await opendir(location.path)) {
        const match = /^([a-f0-9]{64})\.(.+)$/.exec(entry.name);
        const selected = match && assets.get(match[1]);
        if (!selected) continue;
        const identity = await libraryFileIdentity(join(location.path, entry.name));
        if (!identity) throw new Error('Library files changed. Review Delete again.');
        selected.push({ name: entry.name, identity });
    }
    for (const files of assets.values()) files.sort((a, b) => a.name.localeCompare(b.name));
    return assets;
}
