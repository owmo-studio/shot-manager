import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const execute = promisify(execFile);
export interface LibraryLocation { path: string; identity: string; mount: string }
export interface LibraryPresence { existing: Set<string>; complete: Set<string> }

// One flat directory listing; no video, thumbnail, or JSON contents are opened.
export async function listLibrary(location: LibraryLocation) {
    const entries = await readdir(location.path, { withFileTypes: true });
    const assets = new Map<string, { sources: number; thumbnail: boolean; metadata: boolean }>();
    for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.partial')) continue;
        const match = /^([a-f0-9]{64})\.(source\.[a-z0-9]+|thumb\.jpg|metadata\.json)$/.exec(entry.name);
        if (!match) continue;
        const asset = assets.get(match[1]) ?? { sources: 0, thumbnail: false, metadata: false };
        if (match[2].startsWith('source.')) asset.sources++;
        else if (match[2] === 'thumb.jpg') asset.thumbnail = true;
        else asset.metadata = true;
        assets.set(match[1], asset);
    }
    return { names: entries.map(entry => entry.name), existing: new Set(assets.keys()), complete: new Set([...assets].filter(([, asset]) =>
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
    const path = await realpath(chosen);
    if (path !== chosen) throw new Error('The Library location changed. Choose the actual folder in Configuration.');
    if (sources.some(source => within(source, path) || within(path, source))) throw new Error('The Library must be separate from source folders.');
    const info = await stat(path);
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
