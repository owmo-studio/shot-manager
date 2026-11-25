import { lstat, mkdir, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectLibrary, within } from './library';
import { replacementPattern } from './proxyReplacements';
import { scratchFolder } from './proxies';
import { VIDEO_SAMPLE_SCHEME } from '../shared/shots';
import { validateLibraryMetadata } from '../shared/library';
import type { CacheInventory, CacheSummary } from '../shared/desktop';

export type { CacheSelection } from '../shared/desktop';
import type { CacheSelection } from '../shared/desktop';
export const managedCacheDirectory = scratchFolder;

export function cacheFiles(root: string) {
    return {
        root,
        metadata: join(root, 'metadata.json'),
        catalogue: join(root, 'catalogue.json'),
        thumbnails: join(root, 'thumbnails'),
        fingerprints: join(root, 'fingerprints'),
        proxies: join(root, 'proxies'),
        library: { root: join(root, 'library'), thumbnails: join(root, 'library', 'thumbnails') },
    };
}

// Called before backend startup, when no thumbnail jobs are running. Preserve
// existing cached assets without overwriting an already populated new location.
export async function prepareLibraryCache(root: string) {
    const legacy = join(root, 'library-thumbnails');
    const previous = await lstat(legacy).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!previous) return;
    if (!previous.isDirectory() || previous.isSymbolicLink() || await realpath(legacy) !== legacy) throw new Error('Library cache must be a regular folder.');
    const paths = cacheFiles(root).library;
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(paths.root)).isDirectory() || await realpath(paths.root) !== paths.root) throw new Error('Library cache must be a regular folder.');
    const target = await lstat(paths.thumbnails).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (target) {
        if (!target.isDirectory() || target.isSymbolicLink() || await realpath(paths.thumbnails) !== paths.thumbnails) throw new Error('Library thumbnail cache must be a regular folder.');
        return;
    }
    await rename(legacy, paths.thumbnails);
}

const categoryPatterns = {
    catalogue: /^catalogue\.json(?:\.[a-f0-9-]{36}\.tmp)?$/,
    metadata: /^metadata\.json(?:\.[a-f0-9-]{36}\.tmp)?$/,
    thumbnails: /^[a-f0-9]{64}(?:\.jpg(?:\.[a-f0-9-]{36}\.tmp)?|\.[a-f0-9-]{36}\.tmp)$/,
    fingerprints: /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/,
    proxies: /^[a-f0-9]{64}\.proxy\.(?:mov|[a-f0-9-]{36}\.partial)$/,
} as const;
type CacheCategory = keyof typeof categoryPatterns;

async function categoryFiles(directory: string, pattern: RegExp) {
    try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Cache folder is not a regular directory.');
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => join(directory, entry.name));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

async function categoryEntries(root: string, category: CacheCategory) {
    const paths = cacheFiles(root);
    const files = await categoryFiles(category === 'metadata' || category === 'catalogue' ? root : paths[category], categoryPatterns[category]);
    if (category === 'thumbnails') {
        files.push(...await categoryFiles(paths.library.thumbnails, categoryPatterns.thumbnails));
        files.push(...await categoryFiles(join(root, 'library-thumbnails'), categoryPatterns.thumbnails));
    }
    if (category === 'proxies') files.push(...await categoryFiles(root, categoryPatterns.proxies), ...await categoryFiles(paths.proxies, replacementPattern));
    return files;
}

export async function cacheInventory(root: string): Promise<CacheInventory> {
    const inventory: CacheInventory = {
        catalogue: { files: 0, bytes: 0 },
        metadata: { files: 0, bytes: 0 }, thumbnails: { files: 0, bytes: 0 },
        fingerprints: { files: 0, bytes: 0 }, proxies: { files: 0, bytes: 0 }, total: { files: 0, bytes: 0 },
    };
    for (const category of Object.keys(categoryPatterns) as CacheCategory[]) {
        const summary: CacheSummary = inventory[category]!;
        for (const path of await categoryEntries(root, category)) {
            try {
                const info = await lstat(path);
                if (!info.isFile() || info.isSymbolicLink()) continue;
                summary.files++; summary.bytes += info.size;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        inventory.total.files += summary.files;
        inventory.total.bytes += summary.bytes;
    }
    return inventory;
}

async function validFingerprintRecord(path: string, size: number) {
    if (size > 8192) return false;
    try {
        const record = JSON.parse(await readFile(path, 'utf8'));
        const fingerprint = record?.fingerprint;
        return record?.version === 2 && typeof record.fileVersion === 'string' &&
            fingerprint?.scheme === VIDEO_SAMPLE_SCHEME && fingerprint.algorithm === 'sha256' &&
            /^[a-f0-9]{64}$/.test(fingerprint.value) && Number.isSafeInteger(fingerprint.fileSize) &&
            Number.isSafeInteger(fingerprint.sampleBytes) && Number.isSafeInteger(fingerprint.sampledBytes);
    } catch { return false; }
}

// Run only after background work and source scans have stopped. Metadata drafts are pruned by OrganizationStore.
export async function pruneManagedCache(root: string, days = 90, now = Date.now(), activeClipIds = new Set<string>()) {
    if (!Number.isFinite(days) || days <= 0) throw new Error('Cache retention must be a positive number of days.');
    const cutoff = now - days * 86400000;
    const result = { removed: 0, failed: 0 };
    for (const category of ['catalogue', 'metadata', 'thumbnails', 'fingerprints', 'proxies'] as const) {
        for (const path of await categoryEntries(root, category)) {
            try {
                const info = await lstat(path);
                if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
                if (category === 'metadata' && path.endsWith('metadata.json')) continue;
                if (category === 'catalogue' && path.endsWith('catalogue.json')) {
                    try {
                        if (info.size > 64 * 1024 * 1024) continue;
                        const data = JSON.parse(await readFile(path, 'utf8'));
                        if (!data || !Array.isArray(data.entries) || !(data.path === null || typeof data.path === 'string' && data.path.startsWith('/'))) continue;
                        for (const entry of data.entries) validateLibraryMetadata(entry.metadata, entry.metadata?.id);
                    } catch { continue; }
                }
                if (category === 'proxies' && activeClipIds.has(path.split('/').at(-1)!.slice(0, 64))) continue;
                if (category === 'fingerprints' && path.endsWith('.json') && !await validFingerprintRecord(path, info.size)) continue;
                await unlink(path); result.removed++;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.failed++; }
        }
    }
    return result;
}

export async function assertCacheReady(parent: string, expectedRoot: string, mount: string) {
    const location = await inspectLibrary(parent);
    if (location.mount !== mount || join(location.path, scratchFolder) !== expectedRoot) throw new Error('Managed Cache location changed.');
    try {
        const info = await lstat(expectedRoot);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(expectedRoot) !== expectedRoot) throw new Error('Cache storage is not a regular folder.');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

// Only recognized app-owned files. Unknown files and symlinks are left untouched.
export async function clearSelectedCache(root: string, selection: CacheSelection, libraryPath?: string | null) {
    const targets: string[] = [];
    const collectFile = async (path: string, pattern: RegExp) => {
        if (!pattern.test(path.split('/').at(-1)!)) return;
        try {
            const info = await lstat(path);
            if (info.isFile() && !info.isSymbolicLink()) targets.push(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
    const clearDirectory = async (path: string, pattern: RegExp) => {
        let entries;
        try {
            const info = await lstat(path);
            if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Cache subfolder is not a regular directory.');
            entries = await readdir(path, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) if (entry.isFile() && pattern.test(entry.name)) await collectFile(join(path, entry.name), pattern);
    };
    try {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('Cache folder is not a regular directory.');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    const paths = cacheFiles(root);
    if (selection.metadata) {
        await collectFile(paths.metadata, /^metadata\.json$/);
        await clearDirectory(root, /^metadata\.json\.[a-f0-9-]{36}\.tmp$/);
    }
    if (selection.catalogue) {
        await collectFile(paths.catalogue, /^catalogue\.json$/);
        await clearDirectory(root, /^catalogue\.json\.[a-f0-9-]{36}\.tmp$/);
    }
    if (selection.thumbnails) {
        await clearDirectory(paths.thumbnails, categoryPatterns.thumbnails);
        await clearDirectory(paths.library.thumbnails, categoryPatterns.thumbnails);
        await clearDirectory(join(root, 'library-thumbnails'), categoryPatterns.thumbnails);
    }
    if (selection.fingerprints) await clearDirectory(paths.fingerprints, /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/);
    if (selection.proxies) {
        await clearDirectory(paths.proxies, replacementPattern);
        await clearDirectory(paths.proxies, /^[a-f0-9]{64}\.proxy\.mov$|^[a-f0-9]{64}\.proxy\.[a-f0-9-]{36}\.partial$/);
        // Recognize files generated before Cache gained named subfolders.
        await clearDirectory(root, /^[a-f0-9]{64}\.proxy\.mov$|^[a-f0-9]{64}\.proxy\.[a-f0-9-]{36}\.partial$/);
    }
    if (libraryPath && targets.some(path => within(resolve(libraryPath), path))) throw new Error('This Cache data is inside the Library and cannot be cleared safely.');
    for (const path of targets) await unlink(path);
}
