import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LibraryCollection, LibraryMetadata } from '../shared/library';
import { libraryAssetName, parseLibraryAssetName, validateLibraryMetadata } from '../shared/library';
import type { IngestReview } from '../shared/ingestion';
import { ingestAttributes } from '../shared/ingestion';
import { organizationKey } from '../shared/organization';
import type { OrganizationAction } from '../shared/organization';
import type { ShotDetails, VideoShot } from '../shared/shots';
import { libraryFileIdentity, listLibrary, readLibraryAsset, readLibraryMetadata } from './library';
import type { LibraryLocation } from './library';
import type { ShotScanner } from './scanner';
import { ingestionSignature } from './scanner';
import type { IngestQueue } from './ingestion';
import { isJpeg } from './thumbnails';
import { rsyncFile } from './rsync';
import { mediaReadiness } from '../shared/mediaReadiness';

interface CatalogueEntry { metadata: LibraryMetadata; source: string | null; thumbnail: boolean; proxy: boolean; thumbnailRevision?: number; thumbnailDigest?: string }
interface CatalogueState { path: string | null; refreshedAt?: string; entries: CatalogueEntry[] }

export class LibraryCatalogue {
    private state: CatalogueState = { path: null, entries: [] };
    private loaded?: Promise<void>;
    private pending: Promise<unknown> = Promise.resolve();
    private refreshRun?: Promise<LibraryCollection>;
    private refreshing = false;
    private revision = 0;
    private error?: string;
    private warnings: string[] = [];
    private verified = new Map<string, { path: string; error?: string }>();
    private review?: { token: string; location: LibraryLocation; generation: number; created: number; entries: { id: string; attributes: ReturnType<typeof ingestAttributes>; thumbnailDigest?: string }[] };
    private transfer = rsyncFile;
    onChange?: () => void;
    constructor(private scanner: ShotScanner, private configured: () => Promise<string | null>,
        private inspect: () => Promise<LibraryLocation>, private queue: IngestQueue, private file?: string,
        private thumbnails?: string, private assertWritable?: () => Promise<void>) {}

    changed() { this.revision++; this.onChange?.(); }
    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation); this.pending = result.catch(() => undefined); return result;
    }
    private load() {
        if (!this.loaded) this.loaded = (async () => {
            if (!this.file) return;
            try {
                const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
                let data: CatalogueState;
                try {
                    const info = await handle.stat();
                    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Invalid catalogue size.');
                    data = JSON.parse(await handle.readFile('utf8')) as CatalogueState;
                } finally { await handle.close(); }
                if (!data || !(data.path === null || typeof data.path === 'string' && data.path.startsWith('/')) || !Array.isArray(data.entries) ||
                    data.refreshedAt !== undefined && !Number.isFinite(Date.parse(data.refreshedAt))) throw new Error('Invalid catalogue.');
                const ids = new Set<string>();
                for (const entry of data.entries) {
                    const id = entry.metadata?.id;
                    entry.metadata = validateLibraryMetadata(entry.metadata, id);
                    const source = entry.source && parseLibraryAssetName(entry.source);
                    if (ids.has(id) || entry.thumbnailDigest !== undefined && !/^[a-f0-9]{64}$/.test(entry.thumbnailDigest) || entry.thumbnailRevision !== undefined && !Number.isFinite(entry.thumbnailRevision) || entry.source !== null && (!source || source.id !== id || source.role !== 'source') ||
                        typeof entry.thumbnail !== 'boolean' || typeof entry.proxy !== 'boolean') throw new Error('Invalid catalogue entry.');
                    ids.add(id);
                }
                this.state = data;
                if (data.path === await this.configured()) await this.scanner.organization.prepareLibraryCache(data.entries.map(entry => entry.metadata));
                await this.touchCache(this.file);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read the Library catalogue. Cached data has been preserved. Clear the catalogue in Configuration to rebuild it.', { cause: error });
            }
        })();
        return this.loaded;
    }
    private async save(state: CatalogueState) {
        if (this.file) {
            await this.assertWritable?.();
            await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600, flush: true });
                await this.assertWritable?.(); await rename(temporary, this.file);
            } finally { await unlink(temporary).catch(() => undefined); }
        }
        this.state = state; this.changed();
    }
    private async touchCache(path: string) {
        let file;
        try {
            await this.assertWritable?.();
            file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            const info = await file.stat();
            if (info.isFile() && info.nlink === 1) { const used = new Date(); await file.utimes(used, used); }
        } catch { /* A failed usage timestamp must not discard readable cached data. */ }
        finally { await file?.close(); }
    }
    async snapshot(): Promise<LibraryCollection> {
        await this.load();
        const path = await this.configured();
        const entries = this.state.path === path ? this.state.entries : [];
        const drafts = await this.scanner.organization.draftsFor(entries.map(entry => entry.metadata.fingerprint));
        const shots: VideoShot[] = entries.map(entry => {
            const m = entry.metadata;
            const draft = drafts[organizationKey(m.fingerprint)];
            const organization = draft?.data ?? { ...ingestAttributes(m), skipped: false };
            const lock = this.scanner.commitLock(m.id);
            const baselineDigest = entry.thumbnailDigest ?? (draft?.ingestion?.libraryPath === path ? draft.ingestion.thumbnailDigest : undefined);
            const pendingThumbnail = !!draft?.thumbnailDraft && (!entry.thumbnail || draft.thumbnailDraft.digest !== baselineDigest);
            const changed = JSON.stringify(ingestAttributes(organization)) !== JSON.stringify(ingestAttributes(m)) || pendingThumbnail;
            const verification = this.verified.get(m.id);
            const checked = verification?.path === path;
            const thumbnailReady = entry.thumbnail || !!draft?.thumbnailDraft;
            return {
                id: m.id, filePath: entry.source && path ? join(path, entry.source) : '', filename: m.originalFilename,
                relativePath: entry.source ?? '', bytes: m.bytes, timestamp: m.recordedAt, dateSource: m.dateSource,
                dateEvidence: m.dateEvidence, dateConfidence: m.dateConfidence, cameraModel: m.metadata.device.model,
                durationSeconds: m.durationSeconds, metadata: m.metadata, fingerprint: m.fingerprint,
                organization: { ...organization, skipped: false }, hasThumbnail: entry.thumbnail || !!draft?.thumbnailDraft,
                hasCustomThumbnail: pendingThumbnail,
                thumbnailStatus: entry.thumbnail || draft?.thumbnailDraft ? 'ready' : 'failed', thumbnailDigest: draft?.thumbnailDraft?.digest ?? baselineDigest,
                thumbnailRevision: draft?.thumbnailDraft?.revision ?? entry.thumbnailRevision ?? (Date.parse(this.state.refreshedAt ?? '') || 0),
                editable: !lock, available: !!entry.source && !this.error, warnings: m.warnings,
                ingestState: lock ?? (changed ? 'changes-pending' : undefined),
                workKind: this.scanner.workKind(m.id), transferPercent: this.scanner.transferPercent(m.id),
                proxyState: entry.proxy ? 'ready' : 'missing', proxyLocation: entry.proxy ? 'library' : undefined,
                mediaReadiness: mediaReadiness({
                    checked, committed: !changed && !!entry.source && entry.thumbnail && entry.proxy,
                    source: !!entry.source, thumbnail: thumbnailReady, metadata: true, proxy: entry.proxy,
                    error: this.error ?? (checked ? verification?.error ?? (!entry.source ? 'Library source unavailable.' :
                        !thumbnailReady ? 'Library thumbnail unavailable.' : !entry.proxy ? 'Library proxy unavailable.' : undefined) : undefined),
                }),
            };
        });
        return { revision: this.revision, shots, scans: [], libraryPath: path, refreshing: this.refreshing,
            refreshedAt: this.state.path === path ? this.state.refreshedAt : undefined, error: this.error, warnings: [...this.warnings] };
    }
    refresh(): Promise<LibraryCollection> {
        if (this.refreshRun) return this.refreshRun;
        this.refreshing = true; this.changed();
        const run = this.serialize(async () => {
            await this.load();
            try {
                const location = await this.inspect();
                const listing = await listLibrary(location);
                const ids = [...listing.assets.keys()].filter(id => listing.assets.get(id)!.includes(libraryAssetName(id, 'metadata', 'json')));
                const entries = new Map<string, CatalogueEntry>();
                const verified = new Map<string, { path: string; error?: string }>();
                const old = new Map(this.state.path === location.path ? this.state.entries.map(entry => [entry.metadata.id, entry] as const) : []);
                const warnings: string[] = [];
                let next = 0;
                // Small fixed pool: hundreds of JSON opens must not swamp an SMB share.
                await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
                    while (next < ids.length) {
                        const id = ids[next++];
                        try {
                            const { metadata } = await readLibraryMetadata(location, id);
                            const names = listing.assets.get(id)!;
                            const sources = names.filter(name => parseLibraryAssetName(name)?.role === 'source');
                            entries.set(id, { metadata, source: sources.length === 1 && listing.regularAssets.has(sources[0]) ? sources[0] : null,
                                thumbnail: listing.regularAssets.has(libraryAssetName(id, 'thumb', 'jpg')), proxy: listing.proxies.has(id), thumbnailRevision: Date.now(),
                                thumbnailDigest: old.get(id)?.thumbnailDigest });
                            verified.set(id, { path: location.path });
                        } catch (error) {
                            if (old.has(id)) entries.set(id, old.get(id)!);
                            verified.set(id, { path: location.path, error: error instanceof Error ? error.message : String(error) });
                            if (warnings.length < 100) warnings.push(`${id.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                }));
                await this.validateLocation(location);
                const state = { path: location.path, refreshedAt: new Date().toISOString(), entries: [...entries.values()].sort((a,b) => a.metadata.id.localeCompare(b.metadata.id)) };
                const unlocked = state.entries.filter(entry => !this.scanner.commitLock(entry.metadata.id)).map(entry => entry.metadata);
                await this.scanner.organization.syncLibrary(unlocked, () => unlocked.every(entry => !this.scanner.commitLock(entry.id)), location.path);
                await this.save(state);
                this.verified = verified;
                this.error = undefined; this.warnings = warnings;
                await this.scanner.reloadOrganizations();
            } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
            finally { this.refreshing = false; this.changed(); }
            return this.snapshot();
        });
        this.refreshRun = run;
        void run.finally(() => { if (this.refreshRun === run) this.refreshRun = undefined; }).catch(() => undefined);
        return run;
    }
    private async validateLocation(expected: LibraryLocation) {
        const current = await this.inspect();
        if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The Library folder or mounted volume changed.');
    }
    async published(metadata: LibraryMetadata, location: LibraryLocation, names: string[]) {
        return this.serialize(async () => {
            await this.load();
            if (await this.configured() !== location.path) return;
            const entries = this.state.path === location.path ? this.state.entries.filter(entry => entry.metadata.id !== metadata.id) : [];
            entries.push({ metadata, source: names[0], thumbnail: true, proxy: names.length > 3, thumbnailRevision: Date.now() });
            await this.save({ path: location.path, refreshedAt: new Date().toISOString(), entries });
            this.verified.set(metadata.id, { path: location.path });
        });
    }
    async update(ids: string[], action: OrganizationAction) {
        await this.load();
        if (await this.configured() !== this.state.path) throw new Error('The Library changed. Refresh it first.');
        if (action.field === 'skip') throw new Error('Skip is only available in Import.');
        const entries = this.selected(ids);
        await this.scanner.organization.update(entries.map(entry => entry.metadata.fingerprint), action, () => this.scanner.canEditLibrary(ids));
        await this.scanner.reloadOrganizations(); this.changed();
        return { collection: await this.snapshot(), vocabulary: await this.vocabulary() };
    }
    private selected(ids: string[]) {
        const entries = ids.map(id => this.state.entries.find(entry => entry.metadata.id === id));
        if (!ids.length || entries.some(entry => !entry)) throw new Error('Refresh the Library before editing these clips.');
        return entries as CatalogueEntry[];
    }
    async setThumbnail(id: string, dataUrl: string) {
        if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Invalid thumbnail.');
        const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        if (bytes.length > 2 * 1024 * 1024 || !isJpeg(bytes)) throw new Error('Invalid thumbnail.');
        return this.serialize(async () => {
            const { entry, location } = await this.entry(id);
            if (!this.scanner.canEditLibrary([id])) throw new Error('Selected clip is locked.');
            const original = await readLibraryAsset(location, id, 'thumb', 'jpg', 2 * 1024 * 1024);
            const baseline = createHash('sha256').update(original.bytes).digest('hex');
            const digest = createHash('sha256').update(bytes).digest('hex');
            await this.validateLocation(location);
            await this.save({ ...this.state, entries: this.state.entries.map(current => current.metadata.id === id ? { ...current, thumbnailDigest: baseline } : current) });
            const before = (await this.scanner.organization.draftsFor([entry.metadata.fingerprint]))[organizationKey(entry.metadata.fingerprint)];
            const revision = Math.max(Date.now(), (before?.thumbnailDraft?.revision ?? 0) + 1);
            await this.scanner.replaceCachedThumbnails([{ id, metadata: entry.metadata.metadata, bytes }], valid =>
                this.scanner.organization.setThumbnailDraft(entry.metadata.fingerprint, digest === baseline ? undefined : { digest, revision }, valid));
            this.changed();
        });
    }
    async vocabulary() {
        const vocabulary = await this.scanner.organization.vocabulary();
        vocabulary.tags = [...new Set((await this.snapshot()).shots.flatMap(shot => shot.organization?.tags ?? []))].sort();
        return vocabulary;
    }
    async revert(ids: string[]) {
        await this.load();
        if (!this.scanner.canEditLibrary(ids)) throw new Error('Selected clips are locked.');
        const entries = this.selected(ids);
        const before = await this.scanner.organization.draftsFor(entries.map(entry => entry.metadata.fingerprint));
        const expected = Object.fromEntries(Object.entries(before).filter(([, record]) => record).map(([key, record]) => [key, record!.data]));
        const expectedThumbnails = Object.fromEntries(Object.entries(before).map(([key, record]) => [key, record?.thumbnailDraft]));
        const location = await this.inspect();
        if (location.path !== this.state.path) throw new Error('The Library changed. Refresh it first.');
        const fresh: { metadata: LibraryMetadata; thumbnail: Buffer }[] = [];
        for (const id of ids) {
            const { metadata, identity } = await readLibraryMetadata(location, id);
            const thumbnail = await readLibraryAsset(location, id, 'thumb', 'jpg', 2 * 1024 * 1024);
            if (!isJpeg(thumbnail.bytes)) throw new Error('Invalid Library thumbnail.');
            if (await libraryFileIdentity(join(location.path, libraryAssetName(id, 'metadata', 'json'))) !== identity) throw new Error('Library metadata changed while reading. Try Revert again.');
            fresh.push({ metadata, thumbnail: thumbnail.bytes });
        }
        await this.validateLocation(location);
        await this.scanner.replaceCachedThumbnails(fresh.map(({ metadata, thumbnail }) => ({ id: metadata.id, metadata: metadata.metadata, bytes: thumbnail })),
            valid => this.scanner.organization.restore(fresh.map(({ metadata }) => ({ fingerprint: metadata.fingerprint, attributes: metadata })), valid),
            () => this.scanner.organization.matchesDrafts(expected, expectedThumbnails));
        await this.serialize(async () => {
            const updated = new Map(fresh.map(entry => [entry.metadata.id, entry]));
            await this.save({ ...this.state, entries: this.state.entries.map(entry => {
                const fresh = updated.get(entry.metadata.id);
                return fresh ? { ...entry, metadata: fresh.metadata, thumbnail: true, thumbnailRevision: Date.now(),
                    thumbnailDigest: createHash('sha256').update(fresh.thumbnail).digest('hex') } : entry;
            }) });
        });
        this.error = undefined;
        await this.scanner.reloadOrganizations(); this.changed();
        return { collection: await this.snapshot(), vocabulary: await this.vocabulary() };
    }

    async preview(ids: string[]): Promise<IngestReview> {
        const generation = this.queue.workRevision;
        await this.refresh();
        if (this.error) throw new Error(this.error);
        const collection = await this.snapshot();
        const location = await this.inspect();
        const selected = new Set(ids);
        const shots = collection.shots.filter(shot => selected.has(shot.id) && shot.ingestState === 'changes-pending');
        if (!shots.length) throw new Error('No clips need committing.');
        const token = randomUUID();
        if (generation !== this.queue.workRevision) throw new Error('Work was stopped. Commit again when ready.');
        this.review = { token, location, generation, created: Date.now(), entries: shots.map(shot => ({ id: shot.id, attributes: ingestAttributes(shot.organization!), thumbnailDigest: shot.hasCustomThumbnail ? shot.thumbnailDigest : undefined })) };
        return { token, libraryEdits: true, metadataOnly: !shots.some(shot => shot.hasCustomThumbnail), libraryPath: location.path, clips: shots.map(shot => ({ id: shot.id, filename: shot.filename, bytes: 0, mode: 'replace', proxyReady: false,
            files: [...(shot.hasCustomThumbnail ? [{ from: 'Updated thumbnail', to: join(location.path, libraryAssetName(shot.id, 'thumb', 'jpg')) }] : []),
                { from: 'Clip metadata', to: join(location.path, libraryAssetName(shot.id, 'metadata', 'json')) }] })) };
    }
    async submit(token: string, ids: string[]) {
        const review = this.review;
        if (!review || review.token !== token || Date.now() - review.created > 30 * 60_000 || ids.some(id => !review.entries.some(entry => entry.id === id))) throw new Error('Review these changes again.');
        await this.validateLocation(review.location);
        const current = await this.snapshot();
        const captures = await Promise.all(ids.map(async id => {
            const shot = current.shots.find(shot => shot.id === id);
            const entry = review.entries.find(entry => entry.id === id)!;
            if (!shot?.editable || JSON.stringify(ingestAttributes(shot.organization!)) !== JSON.stringify(entry.attributes) ||
                (shot.hasCustomThumbnail ? shot.thumbnailDigest : undefined) !== entry.thumbnailDigest) throw new Error('Local edits changed. Review again.');
            const thumbnail = entry.thumbnailDigest ? await this.scanner.cachedThumbnail(id, shot.metadata) : null;
            if (entry.thumbnailDigest && (!thumbnail || createHash('sha256').update(thumbnail).digest('hex') !== entry.thumbnailDigest)) throw new Error('Pending thumbnail is missing or changed. Set Thumb again.');
            return { id, filename: shot.filename, attributes: structuredClone(entry.attributes), thumbnail: thumbnail ? Buffer.from(thumbnail) : undefined };
        }));
        await this.queue.status();
        if (review.generation !== this.queue.workRevision) throw new Error('Work was stopped. Commit again when ready.');
        const result = this.queue.enqueueLibrary(captures.map(capture => ({ ...capture, execute: signal => this.commit(capture, review.location, signal) })), token);
        this.review = undefined; this.changed(); return result;
    }
    private async commit(capture: { id: string; attributes: ReturnType<typeof ingestAttributes>; thumbnail?: Buffer }, location: LibraryLocation, signal: AbortSignal) {
        const { id, attributes } = capture;
        signal.throwIfAborted(); await this.validateLocation(location);
        const { metadata, identity } = await readLibraryMetadata(location, id);
        const thumbnail = capture.thumbnail ?? (await readLibraryAsset(location, id, 'thumb', 'jpg', 2 * 1024 * 1024)).bytes;
        const digest = createHash('sha256').update(thumbnail).digest('hex');
        const updated = { ...metadata, ...attributes };
        const path = join(location.path, libraryAssetName(id, 'metadata', 'json'));
        const temporary = join(location.path, `${id}.metadata.${randomUUID()}.partial`);
        const staging = capture.thumbnail ? await mkdtemp(join(tmpdir(), 'owmo-library-thumb-')) : undefined;
        try {
            signal.throwIfAborted();
            if (staging && capture.thumbnail) {
                const target = join(location.path, libraryAssetName(id, 'thumb', 'jpg'));
                const expected = await libraryFileIdentity(target);
                const staged = join(staging, libraryAssetName(id, 'thumb', 'jpg'));
                await writeFile(staged, capture.thumbnail, { flag: 'wx', mode: 0o600 });
                await this.validateLocation(location); signal.throwIfAborted();
                if (await libraryFileIdentity(target) !== expected) throw new Error('Library thumbnail changed during Commit. Commit again.');
                await this.transfer(staged, target, signal, () => undefined, true);
            }
            await this.validateLocation(location);
            signal.throwIfAborted();
            await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', flush: true });
            await this.validateLocation(location); signal.throwIfAborted();
            if (await libraryFileIdentity(path) !== identity) throw new Error('Library metadata changed during Commit. Commit again.');
            await rename(temporary, path);
            // Publication won a possible Stop race; persist that success without an abort check.
            await this.scanner.organization.markIngested(metadata.fingerprint, { libraryPath: location.path,
                signature: ingestionSignature(attributes, digest), thumbnailDigest: digest, ingestedAt: new Date().toISOString() });
            await this.serialize(async () => {
                const entries = this.state.entries.map(entry => entry.metadata.id === id ? { ...entry, metadata: updated, thumbnail: true, thumbnailDigest: digest, thumbnailRevision: capture.thumbnail ? Date.now() : entry.thumbnailRevision } : entry);
                await this.save({ ...this.state, entries });
            });
        } finally {
            await this.validateLocation(location).then(() => unlink(temporary)).catch(() => undefined);
            if (staging) await rm(staging, { recursive: true, force: true });
        }
    }
    private async entry(id: string) {
        await this.load();
        const entry = this.selected([id])[0];
        const location = await this.inspect();
        if (this.state.path !== location.path) throw new Error('The Library changed. Refresh it first.');
        return { entry, location };
    }
    async thumbnail(id: string) {
        await this.load();
        if (await this.configured() !== this.state.path) throw new Error('The Library changed. Refresh it first.');
        const entry = this.selected([id])[0];
        const record = (await this.scanner.organization.draftsFor([entry.metadata.fingerprint]))[organizationKey(entry.metadata.fingerprint)];
        if (record?.thumbnailDraft) {
            const bytes = await this.scanner.cachedThumbnail(id, entry.metadata.metadata);
            if (!bytes || createHash('sha256').update(bytes).digest('hex') !== record.thumbnailDraft.digest) throw new Error('Pending thumbnail is missing or changed. Set Thumb again.');
            return `data:image/jpeg;base64,${bytes.toString('base64')}`;
        }
        const key = createHash('sha256').update(JSON.stringify([this.state.path, id, entry.thumbnailRevision ?? this.state.refreshedAt])).digest('hex');
        const cached = this.thumbnails && join(this.thumbnails, `${key}.jpg`);
        if (this.thumbnails) {
            await this.assertWritable?.();
            await mkdir(this.thumbnails, { recursive: true, mode: 0o700 });
            if (!(await lstat(this.thumbnails)).isDirectory() || await realpath(this.thumbnails) !== this.thumbnails) throw new Error('Library thumbnail Cache must be a regular folder.');
        }
        try {
            const { location } = await this.entry(id);
            const image = await readLibraryAsset(location, id, 'thumb', 'jpg', 2 * 1024 * 1024);
            if (cached) {
                await this.assertWritable?.();
                const temporary = `${cached}.${randomUUID()}.tmp`;
                try { await writeFile(temporary, image.bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, cached); }
                finally { await unlink(temporary).catch(() => undefined); }
            }
            return `data:image/jpeg;base64,${image.bytes.toString('base64')}`;
        } catch (error) {
            if (cached) {
                try {
                    const file = await open(cached, constants.O_RDONLY | constants.O_NOFOLLOW);
                    try {
                        const info = await file.stat();
                        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Invalid cached thumbnail.');
                        const image = await file.readFile();
                        if (info.nlink === 1) { const used = new Date(); await file.utimes(used, used).catch(() => undefined); }
                        return `data:image/jpeg;base64,${image.toString('base64')}`;
                    } finally { await file.close(); }
                }
                catch (cacheError) { if ((cacheError as NodeJS.ErrnoException).code !== 'ENOENT') throw cacheError; }
            }
            throw error;
        }
    }
    async openVideo(id: string) {
        const { entry, location } = await this.entry(id);
        if (!entry.source) throw new Error('Library source is missing.');
        const path = join(location.path, entry.source);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { if (!(await file.stat()).isFile()) throw new Error('Library source is not a regular file.'); }
        catch (error) { await file.close(); throw error; }
        return { file, path };
    }
    async details(id: string): Promise<ShotDetails> {
        await this.load(); const { metadata: m, source } = this.selected([id])[0];
        return { file: { filename: m.originalFilename, path: join(this.state.path!, source ?? ''), bytes: m.bytes },
            metadata: m.metadata, fingerprint: m.fingerprint, embeddedMetadata: [{ label: 'Library metadata', format: 'json', text: JSON.stringify(m, null, 2) }], mediaInfo: null, errors: [] };
    }
    async close() { await this.refreshRun; await this.pending; }
}
