import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateClipAttributes } from '../shared/organization';

const execute = promisify(execFile);
export interface LibraryLocation { path: string; identity: string; mount: string }
export interface LibraryPresence { existing: Set<string>; complete: Set<string>; proxies: Set<string> }

export function libraryAssetName(id: string, role: 'source' | 'thumb' | 'metadata' | 'proxy', extension: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-z0-9]+$/.test(extension)) throw new Error('Invalid Library asset identifier.');
    return `${id}.${role}.${extension}`;
}

// One flat directory listing; no video, thumbnail, or JSON contents are opened.
export async function listLibrary(location: LibraryLocation) {
    const entries = await readdir(location.path, { withFileTypes: true });
    const assets = new Map<string, { sources: number; thumbnail: boolean; metadata: boolean }>();
    const proxies = new Set<string>();
    for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.partial')) continue;
        const proxy = /^([a-f0-9]{64})\.proxy\.mov$/.exec(entry.name);
        if (proxy) { proxies.add(proxy[1]); continue; }
        const match = /^([a-f0-9]{64})\.(source\.[a-z0-9]+|thumb\.jpg|metadata\.json)$/.exec(entry.name);
        if (!match) continue;
        const asset = assets.get(match[1]) ?? { sources: 0, thumbnail: false, metadata: false };
        if (match[2].startsWith('source.')) asset.sources++;
        else if (match[2] === 'thumb.jpg') asset.thumbnail = true;
        else asset.metadata = true;
        assets.set(match[1], asset);
    }
    return { names: entries.map(entry => entry.name), proxies, existing: new Set(assets.keys()), complete: new Set([...assets].filter(([, asset]) =>
        asset.sources === 1 && asset.thumbnail && asset.metadata).map(([id]) => id)) };
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
            throw new Error('The configured Library folder is missing. Choose an existing Library location in Configuration.');
        }
        throw error;
    }
    if (path !== chosen) throw new Error('The Library location changed. Choose the actual folder in Configuration.');
    if (sources.some(source => resolve(source) === path)) throw new Error('Choose different folders for Library, Scratch, and sources.');
    let info: Awaited<ReturnType<typeof stat>>;
    try { info = await stat(path); }
    catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new Error('The configured Library folder is missing. Choose an existing Library location in Configuration.');
        }
        throw error;
    }
    if (!info.isDirectory()) throw new Error('The Library is not a folder.');
    return { path, identity: `${info.dev}:${info.ino}:${info.birthtimeMs}`, mount: `${mount.device}:${mount.path}:${mount.type}` };
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
async function readRevertAsset(location: LibraryLocation, id: string, role: 'metadata' | 'thumb', extension: string, limit: number) {
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
    const { bytes } = await readRevertAsset(location, id, 'metadata', 'json', 1024 * 1024);
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
    const thumbnail = await readRevertAsset(location, id, 'thumb', 'jpg', 2 * 1024 * 1024);
    if (thumbnail.bytes.length < 4 || thumbnail.bytes[0] !== 0xff || thumbnail.bytes[1] !== 0xd8 ||
        thumbnail.bytes.at(-2) !== 0xff || thumbnail.bytes.at(-1) !== 0xd9) throw new Error(`Library thumbnail is invalid for clip ${id}.`);
    if (await libraryFileIdentity(metadataPath) !== metadataIdentity) throw new Error('Library metadata changed while reading. Try Revert again.');
    return { attributes, thumbnail: thumbnail.bytes };
}
