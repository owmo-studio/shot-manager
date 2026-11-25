import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ingestAttributes } from '../shared/ingestion';
import type { IngestReview, IngestStatus } from '../shared/ingestion';
import type { StoppableTransfer, WorkQueue } from '../shared/ingestion';
import { ShotScanner } from './scanner';
import { inspectLibrary, libraryAssetName, libraryFileIdentity, listLibrary, readLibraryMetadata, readLibraryRevertAssets } from './library';
import type { LibraryListing, LibraryLocation } from './library';
import { parseLibraryAssetName } from '../shared/library';
import type { LibraryMetadata } from '../shared/library';
import { rsyncFile } from './rsync';
import { AppError } from '../shared/errors';
import type { ProxyQueue } from './proxies';
import { DEFAULT_STORAGE_WAIT_SECONDS, withStorageRecovery } from './storageRecovery';
import type { StorageRetryInfo } from './storageRecovery';
import { reconcileQueueTasks, summarizeQueueTasks } from './queueProgress';
import type { QueueTask } from './queueProgress';

type TransferKind = 'commit' | 'metadata' | 'sync';
const pauseTransfer = Symbol('pause transfer queue');
type Capture = Awaited<ReturnType<ShotScanner['captureIngest']>>;
interface Entry {
    capture: Capture;
    names: [string, string, string, ...string[]];
    existing: Record<string, string | null>;
    transferred?: Record<string, string | null>;
}
interface LibrarySnapshot extends LibraryListing { location: LibraryLocation }
interface Retirement { id: string; filename: string; signature: string }
interface Review { token: string; location: LibraryLocation; entries: Entry[]; retirements: Retirement[]; created: number }
export interface LibraryTransferJob { id: string; filename: string; kind?: TransferKind; execute: (signal: AbortSignal, progress: (percent: number) => void) => Promise<void> }

export class IngestQueue {
    get workRevision() { return this.workGeneration; }
    private review?: Review;
    private working = false;
    private closing = false;
    private runs = new Map<TransferKind, Promise<void>>();
    private preparing?: Promise<void>;
    private controller?: AbortController;
    private queuedIds: string[] = [];
    private cancelledIds = new Set<string>();
    private activeTransfers = new Map<TransferKind, { id: string; controller: AbortController; done: Promise<void> }>();
    private pausing = new Set<WorkQueue>();
    private submission = 0;
    private transferKeys = new Map<string, string>();
    private pending: { entry: Entry; location: LibraryLocation; storageWaitSeconds: number }[] = [];
    private libraryPending: LibraryTransferJob[] = [];
    onPublished?: (metadata: LibraryMetadata, location: LibraryLocation, names: string[]) => Promise<void>;
    private wakeWorker?: () => void;
    private tasks = new Map<string, QueueTask>();
    private progressTimer?: ReturnType<typeof setTimeout>;
    private libraryScanVersion = 0;
    private workGeneration = 0;
    private libraryRefresh?: { path: string; promise: Promise<LibrarySnapshot | undefined>; published: Map<string, Entry['names']>; deleted: Set<string> };
    onChange?: (status: IngestStatus) => void;
    private state: IngestStatus = { revision: 0, libraryPath: null, active: false, stopping: false, position: 0, total: 0, errors: [] };

    constructor(private scanner: ShotScanner, private configuredLibrary: () => Promise<string | null>,
        private inspect = inspectLibrary, private transfer = rsyncFile, private proxies?: ProxyQueue,
        private configuredStorageWait: () => Promise<number> = async () => DEFAULT_STORAGE_WAIT_SECONDS,
        private onStorageRetry: (info: StorageRetryInfo) => void = () => undefined) {
        if (proxies) {
            proxies.onChange = () => this.backgroundChanged();
            proxies.onError = (shot, message) => {
                if (!this.queuedIds.includes(shot.id) && !this.scanner.isEjecting(shot.id)) this.state.errors.push({ id: shot.id, filename: shot.filename, message, eventId: randomUUID(), kind: 'proxy' });
                this.publish();
            };
        }
    }

    backgroundChanged() { this.wakeWorker?.(); this.state.work = this.proxies?.status(); this.publish(); }
    libraryDeleted(path: string, ids: string[]) {
        if (this.libraryRefresh?.path === path) for (const id of ids) {
            this.libraryRefresh.published.delete(id); this.libraryRefresh.deleted.add(id);
        }
        this.scanner.removeLibraryPresence(path, ids);
        this.proxies?.refresh(); this.publish();
    }
    resume() {
        if (this.closing || this.state.stopping) throw new Error('Wait for work to stop before resuming.');
        this.scanner.resumeBackground();
        if (!this.state.pausedQueues?.proxy) this.proxies?.resume();
        this.backgroundChanged();
        return structuredClone(this.state);
    }

    async status() {
        const path = await this.configuredLibrary();
        this.scanner.setIngestLibrary(path);
        if (this.state.libraryPath !== path) {
            this.state.libraryPath = path;
            this.state.libraryScan = undefined;
            this.libraryScanVersion++;
            this.publish();
        }
        if (path && !this.state.libraryScan && !this.closing) void this.scanLibrary();
        this.state.work = this.proxies?.status();
        this.updateTaskProgress();
        return structuredClone(this.state);
    }

    private scanLibrary(): Promise<LibrarySnapshot | undefined> {
        const path = this.state.libraryPath;
        if (!path || this.closing) return Promise.resolve(undefined);
        if (this.libraryRefresh?.path === path) return this.libraryRefresh.promise;
        const version = ++this.libraryScanVersion;
        const current = () => !this.closing && this.state.libraryPath === path && version === this.libraryScanVersion;
        this.state.libraryScan = { state: 'checking' };
        this.scanner.setLibraryPresence(path, null);
        this.publish();
        const refresh = { path, promise: Promise.resolve(undefined) as Promise<LibrarySnapshot | undefined>, published: new Map<string, Entry['names']>(), deleted: new Set<string>() };
        this.libraryRefresh = refresh;
        refresh.promise = (async () => {
            try {
                const location = await this.location();
                if (location.path !== path) throw new Error('The Library changed while checking it. Refresh the Library again.');
                const listing = await listLibrary(location);
                await this.location(location);
                if (!current()) return undefined;
                // A slow listing can predate a Commit completed by our other worker.
                // Keep that acknowledged publication rather than replacing it with stale presence.
                for (const [id, names] of refresh.published) {
                    listing.existing.add(id); listing.complete.add(id);
                    if (names[3]) listing.proxies.add(id);
                    listing.assets.set(id, [...new Set([...(listing.assets.get(id) ?? []), ...names])]);
                }
                for (const id of refresh.deleted) {
                    listing.existing.delete(id); listing.complete.delete(id); listing.proxies.delete(id); listing.assets.delete(id);
                }
                for (const name of listing.regularAssets) if (refresh.deleted.has(name.slice(0, 64))) listing.regularAssets.delete(name);
                this.scanner.setLibraryPresence(path, listing);
                this.proxies?.refresh();
                this.state.libraryScan = { state: 'ready', scannedAt: new Date().toISOString() };
                this.publish();
                return { location, ...listing };
            } catch (error) {
                if (current()) {
                    this.scanner.setLibraryPresence(path, null, error instanceof Error ? error.message : String(error));
                    this.state.libraryScan = { state: 'unavailable', error: error instanceof Error ? error.message : String(error) };
                    this.publish();
                }
                return undefined;
            } finally {
                if (this.libraryRefresh === refresh) this.libraryRefresh = undefined;
            }
        })();
        return refresh.promise;
    }

    async refreshLibrary(afterMutation = false) {
        // A scan already in progress may have listed files before the mutation.
        if (afterMutation) await this.libraryRefresh?.promise;
        await this.status();
        await this.scanLibrary();
        return structuredClone(this.state);
    }

    private lanePaused(kind: TransferKind) {
        return this.state.pausedQueues?.[kind === 'metadata' ? 'commit' : kind] === true;
    }

    async controlQueue(queue: WorkQueue, pause: boolean) {
        if (this.closing || this.state.stopping || this.pausing.has(queue)) {
            throw Object.assign(new Error('Wait for the queue operation to finish.'), { statusCode: 409 });
        }
        const kinds: TransferKind[] = queue === 'commit' ? ['commit', 'metadata'] : queue === 'sync' ? ['sync'] : [];
        (this.state.pausedQueues ??= {})[queue] = pause;
        if (pause) {
            this.pausing.add(queue);
            try {
                if (queue === 'proxy') await this.proxies?.stop(true);
                for (const kind of kinds) this.activeTransfers.get(kind)?.controller.abort(pauseTransfer);
                this.wakeWorker?.();
                this.publish();
                await Promise.all(kinds.map(kind => this.runs.get(kind)));
            } finally { this.pausing.delete(queue); }
        } else if (queue === 'proxy') {
            this.proxies?.resume();
            this.prioritizeCommits();
        } else {
            for (const kind of kinds) this.startWorker(kind);
        }
        this.backgroundChanged();
        return structuredClone(this.state);
    }

    async refreshWork() {
        const generation = this.workGeneration;
        await this.refreshLibrary();
        // Stopping while a read-only presence check finishes must not restart work.
        if (generation === this.workGeneration && !this.closing && !this.state.stopping && this.state.libraryScan?.state === 'ready') this.resume();
        return structuredClone(this.state);
    }

    async revert(ids: string[]) {
        if (this.closing) throw new Error('The app is closing.');
        const unique = [...new Set(ids)];
        const location = await this.location();
        // Restore selected local attributes and thumbnails. Scanner guards protect the clips;
        // unrelated transfers can continue using their immutable snapshots.
        return this.scanner.revertOrganization(unique, async () => {
            const attributes = [];
            for (const id of unique) attributes.push(await readLibraryRevertAssets(location, id));
            await this.location(location);
            return attributes;
        });
    }

    private updateTaskProgress() {
        this.state.metadataActive = this.activeTransfers.has('metadata');
        this.state.metadataPending = this.queuedIds.filter(id => this.scanner.workKind(id) === 'metadata').length;
        const shots = this.scanner.snapshot().shots;
        const ready = new Set(shots.filter(shot => shot.proxyState === 'ready').map(shot => `proxy:${shot.id}`));
        const pending = new Map<string, QueueTask>();
        for (const shot of shots) {
            if (!this.scanner.isEjecting(shot.id) && shot.available && (!shot.organization?.skipped || this.queuedIds.includes(shot.id)) &&
                (shot.proxyState === 'queued' || shot.proxyState === 'encoding')) {
                pending.set(`proxy:${shot.id}`, { kind: 'proxy', percent: Math.max(0, Math.min(99, shot.proxyPercent ?? 0)) });
            }
        }
        for (const work of this.proxies?.replacementProgress?.() ?? []) pending.set(work.key, { kind: 'proxy', percent: work.percent });
        if (this.proxies?.lastCompletedReplacement) ready.add(this.proxies.lastCompletedReplacement);
        for (const id of this.queuedIds) {
            const workKind = this.scanner.workKind(id);
            if (workKind === 'metadata') continue;
            pending.set(this.transferKeys.get(id)!, {
                kind: workKind === 'sync' ? 'sync' : 'transfer',
                percent: [this.state.current, this.state.exportCurrent].find(current => current?.id === id)?.percent ?? 0,
            });
        }
        this.tasks = reconcileQueueTasks(this.tasks, pending, ready);
        this.state.tasks = summarizeQueueTasks(this.tasks);
    }

    // Progress notifications are bounded and carry snapshots, avoiding HTTP/config reads.
    private publish(progress = false) {
        this.updateTaskProgress();
        this.state.revision++;
        if (progress) {
            if (!this.progressTimer) {
                this.progressTimer = setTimeout(() => {
                    this.progressTimer = undefined;
                    this.onChange?.(structuredClone(this.state));
                }, 150);
                this.progressTimer.unref();
            }
            return;
        }
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
        this.onChange?.(structuredClone(this.state));
    }

    private async location(expected?: LibraryLocation, signal?: AbortSignal, configuredWait?: number) {
        const wait = configuredWait ?? await this.configuredStorageWait();
        const location = await withStorageRecovery(async () => {
            const configured = await this.configuredLibrary();
            if (!configured) throw new Error('Set a Library location in Configuration before committing clips.');
            return this.inspect(configured, this.scanner.mediaDirectories());
        }, wait, signal, this.onStorageRetry);
        if (expected && JSON.stringify(location) !== JSON.stringify(expected)) throw new Error('The Library folder or mounted volume changed. Review the commit plan again.');
        return location;
    }

    private beginOperation() {
        if (this.closing || this.working || this.state.stopping) throw Object.assign(new Error('Wait for the current queue operation to finish.'), { statusCode: 409 });
        this.working = true;
    }

    private names(capture: Capture): Entry['names'] {
        const extension = extname(capture.shot.filename).toLowerCase();
        if (!/^\.[a-z0-9]+$/.test(extension)) throw new Error('Unsupported source filename extension.');
        return [libraryAssetName(capture.shot.id, 'source', extension.slice(1)), libraryAssetName(capture.shot.id, 'thumb', 'jpg'), libraryAssetName(capture.shot.id, 'metadata', 'json'),
            ...(this.proxies ? [libraryAssetName(capture.shot.id, 'proxy', 'mov')] : [])];
    }

    private async existing(location: LibraryLocation, id: string, names: Entry['names'], listing?: LibraryListing) {
        const files = listing?.assets.get(id) ?? [];
        // A different extension would create two assets with the same role. Do not silently choose one.
        const unexpected = files.find(name => {
            const asset = parseLibraryAssetName(name);
            return asset && (asset.role === 'source' || asset.role === 'thumb') && !names.includes(name);
        });
        if (unexpected) throw new Error(`Existing asset ${unexpected} uses a different extension. Resolve it before committing this clip.`);
        const entries = await Promise.all(names.map(async name => [name, await libraryFileIdentity(join(location.path, name))] as const));
        return Object.fromEntries(entries);
    }

    async preview(ids: string[], includeSynced = false): Promise<IngestReview> {
        this.beginOperation();
        const generation = this.workGeneration;
        try {
            this.review = undefined;
            await this.status();
            const library = await this.scanLibrary();
            if (!library) throw new Error(this.state.libraryScan?.error ?? 'The Library could not be checked.');
            const { location } = library;
            await this.scanner.reloadOrganizations();
            const retirements = includeSynced ? this.scanner.syncedForReview(ids) : [];
            const syncedIds = new Set(retirements.map(entry => entry.id));
            await this.proxies?.checkConfiguration(ids);
            const entries: Entry[] = [];
            for (const id of [...new Set(ids)]) {
                if (this.queuedIds.includes(id) || syncedIds.has(id)) continue;
                const capture = await this.scanner.captureIngest(id);
                if (library.complete.has(id) && (!this.proxies || library.proxies.has(id)) && capture.shot.ingestion?.libraryPath === location.path && capture.shot.ingestion.signature === capture.signature) continue;
                const names = this.names(capture);
                entries.push({ capture, names, existing: await this.existing(location, id, names, library) });
            }
            if (!entries.length && !retirements.length) throw new Error('No clips need committing.');
            await this.location(location);
            if (generation !== this.workGeneration || this.state.stopping) throw new Error('Work was stopped. Refresh or Commit again when ready.');
            if (!this.state.pausedQueues?.proxy && (this.proxies?.status().paused || this.scanner.workPaused)) this.resume();
            await this.scanner.reloadOrganizations();
            if (generation !== this.workGeneration || this.state.stopping) throw new Error('Work was stopped. Commit again when ready.');
            const present = new Set(this.scanner.snapshot().shots.map(shot => shot.id));
            if (entries.some(entry => !present.has(entry.capture.shot.id) || this.scanner.isEjecting(entry.capture.shot.id) || this.queuedIds.includes(entry.capture.shot.id))) throw new Error('Clips changed while preparing review. Review again.');
            this.scanner.validateSyncedRetirement(retirements);
            this.review = { token: randomUUID(), location, entries, retirements, created: Date.now() };
            return { token: this.review.token, libraryPath: location.path, proxyPreparation: !!this.proxies, clips: entries.map<IngestReview['clips'][number]>(entry => ({
                id: entry.capture.shot.id, filename: entry.capture.shot.filename, bytes: entry.capture.shot.bytes + entry.capture.thumbnail.length,
                mode: entry.names.slice(0, 3).some(name => entry.existing[name]) ? 'replace' : 'new',
                proxyReady: !!(this.proxies && (entry.existing[entry.names[3]] || this.scanner.proxyReady(entry.capture.shot.id))),
                files: entry.names.map((name, index) => ({ from: index === 0 ? entry.capture.path : index === 1 ? 'Current thumbnail' : index === 2 ? 'Clip metadata' : entry.existing[name] ? 'Existing Library proxy (retained)' : 'Generated ProRes proxy', to: join(location.path, name) })),
            })).concat(retirements.map(entry => ({ id: entry.id, filename: entry.filename, bytes: 0, mode: 'synced' as const,
                proxyReady: true, files: [] }))) };
        } finally { this.working = false; }
    }

    async submit(token: string, ids: string[]) {
        this.beginOperation();
        let locked: string[] = [];
        let preparationFinished: (() => void) | undefined;
        try {
            const review = this.review;
            const generation = this.workGeneration;
            if (!review || token !== review.token || Date.now() - review.created > 30 * 60_000) throw new Error('The review expired. Review the commit plan again.');
            const unique = [...new Set(ids)];
            if (!unique.length || unique.some(id => !review.entries.some(entry => entry.capture.shot.id === id) && !review.retirements.some(entry => entry.id === id))) throw new Error('Invalid reviewed selection.');
            const entries = review.entries.filter(entry => unique.includes(entry.capture.shot.id));
            const retirements = review.retirements.filter(entry => unique.includes(entry.id));
            if (!entries.length) {
                await this.location(review.location);
                const listing = await listLibrary(review.location);
                await this.scanner.reloadOrganizations();
                await this.location(review.location);
                if (generation !== this.workGeneration || this.state.stopping) throw new Error('Work was stopped. Review Commit again.');
                this.validateRetirements(retirements, listing);
                this.scanner.retireSynced(retirements);
                this.review = undefined;
                this.state.acceptedReviews = [...(this.state.acceptedReviews ?? []), token].slice(-128);
                this.publish();
                return structuredClone(this.state);
            }
            const transferIds = entries.map(entry => entry.capture.shot.id);
            this.scanner.lockIngest(transferIds);
            locked = transferIds;
            if (!this.state.active) {
                this.controller = new AbortController();
                this.cancelledIds.clear();
                this.transferKeys.clear();
                this.state = { ...this.state, position: 0, completed: 0, waiting: 0, total: 0, current: undefined, exportCurrent: undefined };
            }
            const signal = this.controller!.signal;
            this.state.active = true;
            this.state.total += entries.length;
            this.submission++;
            transferIds.forEach(id => { this.cancelledIds.delete(id); this.transferKeys.set(id, `transfer:${this.submission}:${id}`); });
            this.queuedIds.push(...transferIds);
            this.publish();
            this.preparing = new Promise(resolve => { preparationFinished = resolve; });
            await this.location(review.location);
            signal.throwIfAborted();
            const listing = await listLibrary(review.location);
            for (const entry of entries) {
                signal.throwIfAborted();
                if (this.cancelledIds.has(entry.capture.shot.id)) continue;
                try {
                    const current = await this.scanner.captureIngest(entry.capture.shot.id);
                    signal.throwIfAborted();
                    if (this.cancelledIds.has(entry.capture.shot.id)) continue;
                    if (current.signature !== entry.capture.signature || current.path !== entry.capture.path || current.fileIdentity !== entry.capture.fileIdentity) throw new Error('Clips changed since review. Review the commit plan again.');
                    await this.checkExisting(review.location, entry, listing);
                } catch (error) { if (!this.cancelledIds.has(entry.capture.shot.id)) throw error; }
            }
            await this.scanner.reloadOrganizations();
            await this.location(review.location);
            signal.throwIfAborted();
            if (generation !== this.workGeneration) throw new Error('Work was stopped. Review Commit again.');
            this.validateRetirements(retirements, listing);
            if (!this.state.pausedQueues?.proxy && this.proxies?.status().paused) this.resume();
            this.prioritizeCommits();
            this.proxies?.retry(this.commitIds());
            this.scanner.retireSynced(retirements);
            this.review = undefined;
            const storageWaitSeconds = await this.configuredStorageWait();
            this.pending.push(...entries.filter(entry => !this.cancelledIds.has(entry.capture.shot.id)).map(entry => ({ entry, location: review.location, storageWaitSeconds })));
            this.state.acceptedReviews = [...(this.state.acceptedReviews ?? []), token].slice(-128);
            this.startWorker('commit');
            this.wakeWorker?.();
            locked = []; // Worker owns the locks now.
            return structuredClone(this.state);
        } finally {
            if (locked.length) {
                this.scanner.unlockIngest(locked);
                this.queuedIds = this.queuedIds.filter(id => !locked.includes(id));
                this.state.total -= locked.length;
                if (!this.runs.size) {
                    this.state.active = this.runs.size > 0 || this.queuedIds.length > 0;
                    if (!this.controller?.signal.aborted) this.state.stopping = false;
                    this.state.current = undefined;
                }
                this.publish();
            }
            preparationFinished?.();
            this.preparing = undefined;
            this.wakeWorker?.();
            this.working = false;
        }
    }

    private async checkExisting(location: LibraryLocation, entry: Entry, listing?: LibraryListing) {
        const existing = await this.existing(location, entry.capture.shot.id, entry.names, listing);
        if (JSON.stringify(existing) !== JSON.stringify({ ...entry.existing, ...entry.transferred })) throw new Error('Library assets changed after review. Review the commit plan again to approve replacement.');
    }

    private validateRetirements(entries: Retirement[], listing: LibraryListing) {
        if (entries.some(entry => !listing.complete.has(entry.id) || this.proxies && !listing.proxies.has(entry.id))) throw new Error('Synced Library assets changed. Review Commit again.');
        this.scanner.validateSyncedRetirement(entries);
    }

    private async waitForWork(signal: AbortSignal) {
        if (signal.aborted) return;
        await new Promise<void>(resolve => {
            const wake = () => { signal.removeEventListener('abort', wake); if (this.wakeWorker === wake) this.wakeWorker = undefined; resolve(); };
            this.wakeWorker = wake;
            signal.addEventListener('abort', wake, { once: true });
        });
    }

    private commitIds() { return this.queuedIds.filter(id => this.scanner.workKind(id) === undefined); }
    private prioritizeCommits() { this.proxies?.prioritize(this.commitIds()); }

    private startWorker(kind: TransferKind) {
        const signal = this.controller?.signal;
        if (signal && !signal.aborted && !this.lanePaused(kind) && !this.runs.has(kind)) {
            this.runs.set(kind, Promise.resolve().then(() => this.process(kind, signal)));
        }
    }

    private async process(kind: TransferKind, signal: AbortSignal) {
        const stateKey = kind === 'sync' ? 'exportCurrent' : kind === 'commit' ? 'current' : undefined;
        try {
            while (!signal.aborted && !this.lanePaused(kind)) {
                this.pending = this.pending.filter(item => !this.cancelledIds.has(item.entry.capture.shot.id));
                this.libraryPending = this.libraryPending.filter(job => !this.cancelledIds.has(job.id));
                const jobIndex = this.libraryPending.findIndex(job => (job.kind ?? 'commit') === kind);
                if (jobIndex < 0 && (kind !== 'commit' || (!this.pending.length && !this.preparing))) break;
                const available = new Set(this.scanner.snapshot().shots.filter(shot => shot.available).map(shot => shot.id));
                const index = kind !== 'commit' ? -1 : this.proxies
                    ? this.pending.findIndex(({ entry }) => this.proxies!.readyFor(entry.capture.shot.id) || !available.has(entry.capture.shot.id))
                    : this.pending.length ? 0 : -1;
                if (index < 0 && jobIndex < 0) {
                    this.state.current = undefined; this.state.waiting = this.pending.length; this.publish();
                    await this.waitForWork(signal);
                    continue;
                }
                // Each lane is serial. Ready Import and Library Commits retain their
                // acceptance order; metadata saves and Exports run independently.
                const nextJob = this.libraryPending[jobIndex];
                const libraryJob = nextJob && (index < 0 || this.queuedIds.indexOf(nextJob.id) < this.queuedIds.indexOf(this.pending[index].entry.capture.shot.id))
                    ? this.libraryPending.splice(jobIndex, 1)[0] : undefined;
                const item = libraryJob ? undefined : this.pending.splice(index, 1)[0];
                const shot = libraryJob ?? item!.entry.capture.shot;
                const controller = new AbortController();
                let finish!: () => void;
                const done = new Promise<void>(resolve => { finish = resolve; });
                this.activeTransfers.set(kind, { id: shot.id, controller, done });
                const clipSignal = AbortSignal.any([signal, controller.signal]);
                if (kind === 'commit') this.state.waiting = 0;
                if (stateKey) this.state.position++;
                const current: NonNullable<IngestStatus['current']> | undefined = stateKey ? { id: shot.id, filename: shot.filename, percent: 0, phase: 'transferring', kind: kind === 'sync' ? 'sync' : 'commit' } : undefined;
                if (stateKey) this.state[stateKey] = current;
                this.scanner.processingIngest(shot.id);
                this.publish();
                let requeued = false;
                try {
                    if (libraryJob) await libraryJob.execute(clipSignal, percent => {
                        if (!stateKey || !current || clipSignal.aborted || this.state[stateKey] !== current) return;
                        current.percent = Math.max(0, Math.min(99, percent));
                        this.scanner.setTransferProgress(shot.id, current.percent); this.publish(true);
                    });
                    else await this.execute(item!.entry, item!.location, clipSignal, item!.storageWaitSeconds);
                    if (current) current.percent = 100;
                    if (stateKey) this.state.completed = (this.state.completed ?? 0) + 1;
                    this.publish();
                } catch (error) {
                    const unknown = error instanceof AppError && error.outcome === 'unknown';
                    if (!unknown && clipSignal.reason === pauseTransfer && !signal.aborted && !this.cancelledIds.has(shot.id)) {
                        if (libraryJob) this.libraryPending.splice(jobIndex, 0, libraryJob);
                        else this.pending.splice(index, 0, item!);
                        this.tasks.delete(this.transferKeys.get(shot.id)!);
                        if (stateKey) { this.state[stateKey] = undefined; this.state.position--; }
                        this.scanner.requeueIngest(shot.id);
                        requeued = true;
                    } else if (unknown || !clipSignal.aborted) this.state.errors.push({ id: shot.id, filename: shot.filename,
                        message: error instanceof Error ? error.message : String(error), eventId: randomUUID(), kind: kind === 'sync' ? 'sync' : 'commit' });
                    this.publish();
                } finally {
                    if (!requeued) {
                        this.queuedIds = this.queuedIds.filter(id => id !== shot.id);
                        this.scanner.unlockIngest([shot.id]);
                    }
                    this.prioritizeCommits();
                    this.activeTransfers.delete(kind); finish();
                }
            }
        } finally {
            // A lane must never clear the other lane's jobs, locks, or progress.
            if (signal.aborted || !this.lanePaused(kind)) {
                const remaining = this.queuedIds.filter(id => (this.scanner.workKind(id) ?? 'commit') === kind);
                this.scanner.unlockIngest(remaining);
                this.queuedIds = this.queuedIds.filter(id => !remaining.includes(id));
                if (kind === 'commit') this.pending = [];
                this.libraryPending = this.libraryPending.filter(job => (job.kind ?? 'commit') !== kind);
            }
            if (kind === 'commit') this.state.waiting = 0;
            if (kind === 'metadata') this.state.metadataRevision = (this.state.metadataRevision ?? 0) + 1;
            this.runs.delete(kind);
            this.state.active = this.runs.size > 0 || this.queuedIds.length > 0;
            if (stateKey) this.state[stateKey] = undefined;
            this.publish();
        }
    }

    enqueueLibrary(jobs: LibraryTransferJob[], reviewToken?: string) {
        this.beginOperation();
        try {
            if (!jobs.length || jobs.some(job => this.queuedIds.includes(job.id))) throw new Error('Selected clips are already queued.');
            const ids = jobs.map(job => job.id);
            if (new Set(ids).size !== ids.length) throw new Error('Invalid transfer submission.');
            if (!this.scanner.canEditLibrary(ids)) throw new Error('Selected clips are locked.');
            const transferJobs = jobs.filter(job => (job.kind ?? 'commit') !== 'metadata');
            const groups = new Map<TransferKind, LibraryTransferJob[]>();
            for (const job of jobs) {
                const kind = job.kind ?? 'commit';
                const group = groups.get(kind) ?? [];
                group.push(job); groups.set(kind, group);
            }
            for (const [kind, group] of groups) this.scanner.lockLibraryCommit(group.map(job => job.id), kind);
            if (!this.state.active) {
                this.controller = new AbortController(); this.cancelledIds.clear(); this.transferKeys.clear();
                this.state = { ...this.state, position: 0, completed: 0, waiting: 0, total: 0, current: undefined, exportCurrent: undefined };
                if (!transferJobs.length && ![...this.tasks.values()].some(task => task.percent < 100)) this.tasks.clear();
            }
            this.state.active = true; this.state.total += transferJobs.length; this.submission++;
            if (groups.has('metadata')) this.state.metadataRevision = (this.state.metadataRevision ?? 0) + 1;
            for (const job of jobs) {
                this.cancelledIds.delete(job.id); this.queuedIds.push(job.id);
                this.transferKeys.set(job.id, `transfer:${this.submission}:${job.id}`);
            }
            this.libraryPending.push(...jobs); this.publish();
            if (reviewToken) this.state.acceptedReviews = [...(this.state.acceptedReviews ?? []), reviewToken].slice(-128);
            for (const kind of groups.keys()) this.startWorker(kind);
            this.wakeWorker?.();
            return structuredClone(this.state);
        } finally { this.working = false; }
    }

    async cancel(ids: string[], kind?: StoppableTransfer) {
        if (this.closing) throw new Error('The app is closing.');
        // Import Commits have no explicit work kind; Library operations do.
        const selected = ids.filter(id => this.queuedIds.includes(id) &&
            (!kind || this.scanner.workKind(id) === (kind === 'commit' ? undefined : 'sync')));
        const active = [...this.activeTransfers.values()].filter(transfer => selected.includes(transfer.id));
        selected.forEach(id => this.cancelledIds.add(id));
        this.pending = this.pending.filter(item => !selected.includes(item.entry.capture.shot.id));
        this.libraryPending = this.libraryPending.filter(job => !selected.includes(job.id));
        this.queuedIds = this.queuedIds.filter(id => !selected.includes(id));
        active.forEach(transfer => transfer.controller.abort());
        this.scanner.unlockIngest(selected.filter(id => !active.some(transfer => transfer.id === id)));
        this.prioritizeCommits();
        this.wakeWorker?.();
        if (this.review?.entries.some(entry => selected.includes(entry.capture.shot.id))) this.review = undefined;
        await Promise.all([kind === 'sync' ? undefined : this.preparing, ...active.map(transfer => transfer.done)]);
        // A publication that beat cancellation has already persisted its successful receipt.
        this.state.active = this.runs.size > 0 || this.queuedIds.length > 0;
        this.publish();
        return this.scanner.snapshot();
    }

    async eject(ids: string[]) {
        if (this.closing) throw new Error('The app is closing.');
        const unique = [...new Set(ids)];
        if (unique.some(id => this.queuedIds.includes(id) || [...this.activeTransfers.values()].some(transfer => transfer.id === id))) {
            throw new AppError('Stop queued or active commits before ejecting these clips.', 'CLIP_COMMIT_ACTIVE', 'failed', 409);
        }
        this.scanner.beginEject(unique);
        try {
            if (this.review?.entries.some(entry => unique.includes(entry.capture.shot.id))) this.review = undefined;
            await Promise.all([this.proxies?.cancel(unique), this.scanner.settleEject(unique)]);
            this.state.errors = this.state.errors.filter(error => !unique.includes(error.id));
            const collection = this.scanner.finishEject(unique);
            this.publish();
            return collection;
        } catch (error) {
            this.scanner.abortEject(unique);
            throw error;
        }
    }

    private async execute(entry: Entry, location: LibraryLocation, signal: AbortSignal, configuredWait: number) {
        const { shot, path, fileIdentity, thumbnail, signature } = entry.capture;
        const validate = async () => {
            signal.throwIfAborted();
            await this.location(location, signal, configuredWait);
            await this.scanner.validateIngest(shot.id, path, fileIdentity);
            signal.throwIfAborted();
        };
        await validate();
        await this.checkExisting(location, entry);
        const previous = entry.existing[entry.names[2]] ? await readLibraryMetadata(location, shot.id) : null;
        if (previous && previous.identity !== entry.existing[entry.names[2]]) throw new Error('Library metadata changed after review.');
        // checkExisting has just validated a reviewed Library proxy. The
        // shared presence index may be temporarily unverified during Refresh.
        const proxy = this.proxies && !entry.existing[entry.names[3]] ? await this.proxies.asset(shot.id) : null;
        const staging = await mkdtemp(join(tmpdir(), 'shot-manager-ingest-'));
        const metadataPath = join(location.path, entry.names[2]);
        const temporaryJSON = join(location.path, `${shot.id}.metadata.${randomUUID()}.partial`);
        try {
            const stagedThumb = join(staging, entry.names[1]);
            await writeFile(stagedThumb, thumbnail, { mode: 0o600 });
            const totalBytes = shot.bytes + thumbnail.length + (proxy?.bytes ?? 0);
            const update = (bytes: number) => {
                // Transfer bytes exclude metadata publication and the saved receipt.
                // Reserve 100% until the entire clip has finished successfully.
                const percent = Math.min(99, Math.round(bytes / Math.max(totalBytes, 1) * 100));
                if (!signal.aborted && this.state.current?.id === shot.id && this.state.current.percent !== percent) {
                    this.state.current.percent = percent;
                    this.scanner.setTransferProgress(shot.id, percent);
                    this.publish(true);
                }
            };
            const transfers = [{ from: path, name: entry.names[0], bytes: shot.bytes, force: false },
                { from: stagedThumb, name: entry.names[1], bytes: thumbnail.length, force: true },
                ...(proxy ? [{ from: proxy.path, name: entry.names[3], bytes: proxy.bytes, force: false }] : [])];
            let transferred = 0;
            for (const file of transfers) {
                await validate();
                if (proxy && file.from === proxy.path && await libraryFileIdentity(proxy.path) !== proxy.identity) throw new Error('Cached proxy changed before transfer.');
                const target = join(location.path, file.name);
                const completed = entry.transferred && Object.hasOwn(entry.transferred, file.name);
                if (await libraryFileIdentity(target) !== (completed ? entry.transferred![file.name] : entry.existing[file.name])) throw new Error('Destination changed after review.');
                if (!completed) {
                    await this.transfer(file.from, target, signal, percent => update(transferred + file.bytes * percent / 100), file.force);
                    await this.location(location, undefined, configuredWait);
                    (entry.transferred ??= {})[file.name] = await libraryFileIdentity(target);
                }
                transferred += file.bytes;
            }
            await validate();
            this.state.current!.phase = 'metadata';
            this.state.current!.percent = 99;
            this.scanner.setTransferProgress(shot.id, 99);
            this.publish();
            const ingestedAt = new Date().toISOString();
            const original = previous?.metadata ?? {
                id: shot.id, fingerprint: shot.fingerprint!, originalFilename: shot.filename, bytes: shot.bytes,
                recordedAt: shot.timestamp, dateSource: shot.dateSource, dateEvidence: shot.dateEvidence, dateConfidence: shot.dateConfidence,
                durationSeconds: shot.durationSeconds, metadata: shot.metadata, warnings: shot.warnings,
            };
            const metadata: LibraryMetadata = {
                ...original, ...ingestAttributes(shot.organization!),
                ingestion: { ...previous?.metadata.ingestion, completedAt: ingestedAt, transfer: 'rsync' },
            };
            await writeFile(temporaryJSON, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', flush: true });
            await validate();
            if (await libraryFileIdentity(metadataPath) !== entry.existing[entry.names[2]]) throw new Error('Library metadata changed after review.');
            signal.throwIfAborted();
            await rename(temporaryJSON, metadataPath);
            // Publication is the completion boundary. A concurrent Stop must preserve this success.
            await this.scanner.markIngested(shot.id, { libraryPath: location.path, signature, thumbnailDigest: shot.thumbnailDigest, ingestedAt });
            if (this.libraryRefresh?.path === location.path) {
                this.libraryRefresh.deleted.delete(shot.id); this.libraryRefresh.published.set(shot.id, entry.names);
            }
            await this.proxies?.published(shot.id, proxy, location.path);
            await this.onPublished?.(metadata, location, entry.names);
        } finally {
            await unlink(temporaryJSON).catch(() => undefined);
            await rm(staging, { recursive: true, force: true });
        }
    }

    private async cancelTransfers() {
        this.review = undefined;
        this.controller?.abort();
        await this.preparing;
        await Promise.all(this.runs.values());
        this.scanner.unlockIngest(this.queuedIds);
        this.queuedIds = []; this.pending = []; this.libraryPending = [];
        this.state.active = false;
        this.proxies?.prioritize([]);
    }

    async stop() {
        this.workGeneration++;
        this.state.stopping = true; this.publish();
        await Promise.all([this.cancelTransfers(), this.proxies?.stop()]);
        this.state.stopping = false;
        this.state.work = this.proxies?.status();
        this.publish();
        return structuredClone(this.state);
    }

    dismissError(eventId: string) {
        const remaining = this.state.errors.filter(error => error.eventId !== eventId);
        if (remaining.length !== this.state.errors.length) { this.state.errors = remaining; this.publish(); }
    }

    async close() {
        this.closing = true;
        await this.stop();
        await this.scanner.pauseBackground();
        await this.libraryRefresh?.promise;
        clearTimeout(this.progressTimer);
        this.onChange = undefined;
    }
}
