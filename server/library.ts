import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateClipAttributes } from '../shared/organization';
import { libraryAssetName, parseLibraryAssetName, validateLibraryMetadata } from '../shared/library';

export { libraryAssetName } from '../shared/library';

const execute = promisify(execFile);
export interface LibraryLocation { path: string; identity: string; mount: string }
export interface LibraryPresence { existing: Set<string>; complete: Set<string>; proxies: Set<string> }

export interface LibraryListing extends LibraryPresence { assets: Map<string, string[]>; regularAssets: Set<string> }

// Stream one flat listing and index by clip, rather than retaining all Dirents or
// searching the full Library once per reviewed clip. No asset contents are opened.
export async function listLibrary(location: LibraryLocation): Promise<LibraryListing> {
    return indexLibraryEntries(await opendir(location.path));
}

export async function indexLibraryEntries(entries: AsyncIterable<Pick<Dirent, 'name' | 'isFile'>>): Promise<LibraryListing> {
    const assets = new Map<string, string[]>();
    const core = new Map<string, { sources: number; thumbnail: boolean; metadata: boolean }>();
    const proxies = new Set<string>();
    const regularAssets = new Set<string>();
    for await (const entry of entries) {
        const match = parseLibraryAssetName(entry.name);
        if (!match) continue;
        const names = assets.get(match.id) ?? [];
        names.push(entry.name); assets.set(match.id, names);
        // Non-files still participate in conflict detection, but never prove presence.
        if (!entry.isFile()) continue;
        regularAssets.add(entry.name);
        if (match.role === 'proxy' && match.extension === 'mov') { proxies.add(match.id); continue; }
        if (match.role !== 'source' && !(match.role === 'thumb' && match.extension === 'jpg') &&
            !(match.role === 'metadata' && match.extension === 'json')) continue;
        const asset = core.get(match.id) ?? { sources: 0, thumbnail: false, metadata: false };
        if (match.role === 'source') asset.sources++;
        else if (match.role === 'thumb') asset.thumbnail = true;
        else asset.metadata = true;
        core.set(match.id, asset);
    }
    const complete = new Set<string>();
    for (const [id, asset] of core) if (asset.sources === 1 && asset.thumbnail && asset.metadata) complete.add(id);
    return { assets, proxies, existing: new Set(core.keys()), complete, regularAssets };
}

export function within(parent: string, child: string) {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

// The mount table is checked before accessing the chosen directory. In particular,
// an empty /Volumes/Share directory must never stand in for a disconnected share.
export async function inspectLibrary(configured: string, sources: string[] = []): Promise<LibraryLocation> {
    if (!isAbsolute(configured) || configured.includes('\0')) throw new Error('Choose a Library folder in Configuration.');
    const { stdout } = await execute('/sbin/mount', [], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const mounts = stdout.split('\n').flatMap(line => {
        const match = /^(.*?) on (.*?) \(([^, )]+)/.exec(line);
        return match ? [{ device: match[1], path: match[2], type: match[3] }] : [];
    });
    const chosen = resolve(configured);
    const mount = mounts.filter(item => within(item.path, chosen)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!mount || (within('/Volumes', chosen) && !within('/Volumes', mount.path))) throw new Error('The Library volume is not mounted.');
    let path: string;
    try { path = await realpath(chosen); }
    catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new Error('The configured Library folder is missing. Choose an existing Library location in Configuration.', { cause: error });
        }
        throw error;
    }
    if (path !== chosen) throw new Error('The Library location changed. Choose the actual folder in Configuration.');
    if (sources.some(source => resolve(source) === path)) throw new Error('Choose different folders for the Library, Cache, and sources.');
    let info: Awaited<ReturnType<typeof stat>>;
    try { info = await stat(path, { bigint: true }); }
    catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new Error('The configured Library folder is missing. Choose an existing Library location in Configuration.', { cause: error });
        }
        throw error;
    }
    if (!info.isDirectory()) throw new Error('The Library is not a folder.');
    // Directory creation/change timestamps are not stable over SMB: Samba may
    // update them as children are created or removed. Device and inode identify
    // the directory object without treating ordinary Library writes as a swap.
    return { path, identity: `${info.dev}:${info.ino}`, mount: `${mount.device}:${mount.path}:${mount.type}` };
}

export async function libraryFileIdentity(path: string): Promise<string | null> {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Library asset is not a regular file: ${path}`);
        return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

// Selected Revert assets only; never read source videos or enumerate Library contents.
export async function readLibraryAsset(location: LibraryLocation, id: string, role: 'metadata' | 'thumb', extension: string, limit: number) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid clip ID.');
    const label = role === 'thumb' ? 'thumbnail' : 'metadata';
    const path = join(location.path, libraryAssetName(id, role, extension));
    const identity = await libraryFileIdentity(path);
    if (!identity) throw new Error(`Library ${label} is missing for clip ${id}.`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > limit) throw new Error(`Library ${label} exceeds the supported size.`);
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > limit) throw new Error(`Library ${label} exceeds the size limit.`);
        const current = await file.stat();
        if ([current.dev, current.ino, current.size, current.mtimeMs, current.ctimeMs].join(':') !== identity ||
            await libraryFileIdentity(path) !== identity) throw new Error(`Library ${label} changed while reading. Try Revert again.`);
        return { bytes: buffer.subarray(0, length), identity, path };
    } finally { await file.close(); }
}

export async function readLibraryAttributes(location: LibraryLocation, id: string) {
    const { bytes } = await readLibraryAsset(location, id, 'metadata', 'json', 1024 * 1024);
    let data: Record<string, unknown>;
    try { data = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('Library metadata contains invalid JSON. Local changes have been preserved.'); }
    if (!data || data.id !== id) throw new Error('Library metadata does not match this clip.');
    return validateClipAttributes(data);
}

export async function readLibraryRevertAssets(location: LibraryLocation, id: string) {
    const metadataPath = join(location.path, libraryAssetName(id, 'metadata', 'json'));
    const metadataIdentity = await libraryFileIdentity(metadataPath);
    const attributes = await readLibraryAttributes(location, id);
    const thumbnail = await readLibraryAsset(location, id, 'thumb', 'jpg', 2 * 1024 * 1024);
    if (thumbnail.bytes.length < 4 || thumbnail.bytes[0] !== 0xff || thumbnail.bytes[1] !== 0xd8 ||
        thumbnail.bytes.at(-2) !== 0xff || thumbnail.bytes.at(-1) !== 0xd9) throw new Error(`Library thumbnail is invalid for clip ${id}.`);
    if (await libraryFileIdentity(metadataPath) !== metadataIdentity) throw new Error('Library metadata changed while reading. Try Revert again.');
    return { attributes, thumbnail: thumbnail.bytes };
}

export async function readLibraryMetadata(location: LibraryLocation, id: string) {
    const asset = await readLibraryAsset(location, id, 'metadata', 'json', 1024 * 1024);
    let data: unknown;
    try { data = JSON.parse(asset.bytes.toString('utf8')); }
    catch { throw new Error(`Library metadata contains invalid JSON for ${id}.`); }
    return { metadata: validateLibraryMetadata(data, id), identity: asset.identity };
}
