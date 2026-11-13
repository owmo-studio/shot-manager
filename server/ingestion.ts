import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ingestAttributes } from '../shared/ingestion';
import type { IngestReview, IngestStatus } from '../shared/ingestion';
import { ShotScanner } from './scanner';
import { inspectLibrary, libraryAssetName, libraryFileIdentity, listLibrary, readLibraryRevertAssets } from './library';
import type { LibraryListing, LibraryLocation } from './library';
import { parseLibraryAssetName } from '../shared/library';
import type { LibraryMetadata } from '../shared/library';
import { rsyncFile } from './rsync';
import { AppError } from '../shared/errors';
import type { ProxyQueue } from './proxies';

type Capture = Awaited<ReturnType<ShotScanner['captureIngest']>>;
interface Entry {
    capture: Capture;
    names: [string, string, string, ...string[]];
    existing: Record<string, string | null>;
}
interface LibrarySnapshot extends LibraryListing { location: LibraryLocation }
interface Review { token: string; location: LibraryLocation; entries: Entry[]; created: number }

export class IngestQueue {
    private review?: Review;
    private working = false;
    private closing = false;
    private run?: Promise<void>;
    private preparing?: Promise<void>;
    private controller?: AbortController;
    private queuedIds: string[] = [];
    private cancelledIds = new Set<string>();
    private activeTransfer?: { id: string; controller: AbortController; done: Promise<void> };
    private submission = 0;
    private transferKeys = new Map<string, string>();
    private pending: { entry: Entry; location: LibraryLocation }[] = [];
    private wakeWorker?: () => void;
    private tasks = new Map<string, { kind: 'proxy' | 'transfer'; percent: number }>();
    private progressTimer?: ReturnType<typeof setTimeout>;
    private libraryScanVersion = 0;
    private workGeneration = 0;
    private libraryRefresh?: { path: string; promise: Promise<LibrarySnapshot | undefined>; published: Map<string, Entry['names']> };
    onChange?: (status: IngestStatus) => void;
    private state: IngestStatus = { revision: 0, libraryPath: null, active: false, stopping: false, position: 0, total: 0, errors: [] };

    constructor(private scanner: ShotScanner, private configuredLibrary: () => Promise<string | null>,
        private inspect = inspectLibrary, private transfer = rsyncFile, private proxies?: ProxyQueue) {
        if (proxies) {
            proxies.onChange = () => this.backgroundChanged();
            proxies.onError = (shot, message) => {
                if (!this.queuedIds.includes(shot.id) && !this.scanner.isEjecting(shot.id)) this.state.errors.push({ id: shot.id, filename: shot.filename, message, eventId: randomUUID() });
                this.publish();
            };
        }
    }

    backgroundChanged() { this.wakeWorker?.(); this.state.work = this.proxies?.status(); this.publish(); }
    resume() {
        if (this.closing || this.state.stopping) throw new Error('Wait for work to stop before resuming.');
        this.scanner.resumeBackground(); this.proxies?.resume(); this.backgroundChanged(); return structuredClone(this.state);
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
        const refresh = { path, promise: Promise.resolve(undefined) as Promise<LibrarySnapshot | undefined>, published: new Map<string, Entry['names']>() };
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
                this.scanner.setLibraryPresence(path, listing);
                this.proxies?.refresh();
                this.state.libraryScan = { state: 'ready', scannedAt: new Date().toISOString() };
                this.publish();
                return { location, ...listing };
            } catch (error) {
                if (current()) {
                    this.scanner.setLibraryPresence(path, null);
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

    async refreshLibrary() {
        this.beginOperation();
        try {
            await this.status();
            await this.scanLibrary();
            return structuredClone(this.state);
        } finally { this.working = false; }
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
        const shots = this.scanner.snapshot().shots;
        const ready = new Set(shots.filter(shot => shot.proxyState === 'ready').map(shot => `proxy:${shot.id}`));
        const pending = new Map<string, { kind: 'proxy' | 'transfer'; percent: number }>();
        for (const shot of shots) {
            if (!this.scanner.isEjecting(shot.id) && shot.available && (!shot.organization?.skipped || this.queuedIds.includes(shot.id)) &&
                (shot.proxyState === 'queued' || shot.proxyState === 'encoding')) {
                pending.set(`proxy:${shot.id}`, { kind: 'proxy', percent: Math.max(0, Math.min(99, shot.proxyPercent ?? 0)) });
            }
        }
        for (const id of this.queuedIds) pending.set(this.transferKeys.get(id)!, {
            kind: 'transfer', percent: this.state.current?.id === id ? this.state.current.percent : 0,
        });
        // Retain completed work while a session is running. New work after idle starts a fresh count.
        if (![...this.tasks.values()].some(task => task.percent < 100) && [...pending.keys()].some(key => !this.tasks.has(key))) this.tasks.clear();
        for (const [key, task] of this.tasks) {
            if (task.kind === 'proxy' && ready.has(key)) task.percent = 100;
            // Skipped, removed, failed, or cancelled work leaves the remaining task list.
            if (task.percent < 100 && !pending.has(key)) this.tasks.delete(key);
        }
        for (const [key, task] of pending) this.tasks.set(key, { ...task, percent: Math.max(task.percent, this.tasks.get(key)?.percent ?? 0) });
        const tasks = [...this.tasks.values()];
        const completed = tasks.filter(task => task.percent === 100).length;
        this.state.tasks = {
            completed, total: tasks.length,
            percent: tasks.length ? Math.min(completed === tasks.length ? 100 : 99, Math.floor(tasks.reduce((sum, task) => sum + task.percent, 0) / tasks.length)) : 0,
            proxiesRemaining: tasks.filter(task => task.kind === 'proxy' && task.percent < 100).length,
            transfersRemaining: tasks.filter(task => task.kind === 'transfer' && task.percent < 100).length,
        };
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

    private async location(expected?: LibraryLocation) {
        const configured = await this.configuredLibrary();
        if (!configured) throw new Error('Set a Library location in Configuration before committing clips.');
        const location = await this.inspect(configured, this.scanner.mediaDirectories());
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

    async preview(ids: string[]): Promise<IngestReview> {
        this.beginOperation();
        const generation = this.workGeneration;
        try {
            this.review = undefined;
            await this.status();
            const library = await this.scanLibrary();
            if (!library) throw new Error(this.state.libraryScan?.error ?? 'The Library could not be checked.');
            const { location } = library;
            await this.proxies?.checkConfiguration(ids);
            const entries: Entry[] = [];
            for (const id of [...new Set(ids)]) {
                if (this.queuedIds.includes(id)) continue;
                const capture = await this.scanner.captureIngest(id);
                if (library.complete.has(id) && (!this.proxies || library.proxies.has(id)) && capture.shot.ingestion?.libraryPath === location.path && capture.shot.ingestion.signature === capture.signature) continue;
                const names = this.names(capture);
                entries.push({ capture, names, existing: await this.existing(location, id, names, library) });
            }
            if (!entries.length) throw new Error('No clips need committing.');
            await this.location(location);
            if (generation !== this.workGeneration || this.state.stopping) throw new Error('Work was stopped. Refresh or Commit again when ready.');
            if (this.proxies?.status().paused || this.scanner.workPaused) this.resume();
            const present = new Set(this.scanner.snapshot().shots.map(shot => shot.id));
            if (entries.some(entry => !present.has(entry.capture.shot.id) || this.scanner.isEjecting(entry.capture.shot.id) || this.queuedIds.includes(entry.capture.shot.id))) throw new Error('Clips changed while preparing review. Review again.');
            this.review = { token: randomUUID(), location, entries, created: Date.now() };
            return { token: this.review.token, libraryPath: location.path, proxyPreparation: !!this.proxies, clips: entries.map(entry => ({
                id: entry.capture.shot.id, filename: entry.capture.shot.filename, bytes: entry.capture.shot.bytes + entry.capture.thumbnail.length,
                mode: entry.names.slice(0, 3).some(name => entry.existing[name]) ? 'replace' : 'new',
                proxyReady: !!(this.proxies && (entry.existing[entry.names[3]] || this.scanner.proxyReady(entry.capture.shot.id))),
                files: entry.names.map((name, index) => ({ from: index === 0 ? entry.capture.path : index === 1 ? 'Current thumbnail' : index === 2 ? 'Clip metadata' : entry.existing[name] ? 'Existing Library proxy (retained)' : 'Generated ProRes proxy', to: join(location.path, name) })),
            })) };
        } finally { this.working = false; }
    }

    async submit(token: string, ids: string[]) {
        this.beginOperation();
        let locked: string[] = [];
        let preparationFinished: (() => void) | undefined;
        try {
            const review = this.review;
            if (!review || token !== review.token || Date.now() - review.created > 30 * 60_000) throw new Error('The review expired. Review the commit plan again.');
            const unique = [...new Set(ids)];
            if (!unique.length || unique.some(id => !review.entries.some(entry => entry.capture.shot.id === id))) throw new Error('Invalid reviewed selection.');
            const entries = review.entries.filter(entry => unique.includes(entry.capture.shot.id));
            this.scanner.lockIngest(unique);
            locked = unique;
            if (!this.state.active) {
                this.controller = new AbortController();
                this.cancelledIds.clear();
                this.transferKeys.clear();
                this.state = { ...this.state, position: 0, completed: 0, waiting: 0, total: 0, current: undefined };
            }
            const signal = this.controller!.signal;
            this.state.active = true;
            this.state.total += entries.length;
            this.submission++;
            unique.forEach(id => { this.cancelledIds.delete(id); this.transferKeys.set(id, `transfer:${this.submission}:${id}`); });
            this.queuedIds.push(...unique);
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
            signal.throwIfAborted();
            this.review = undefined;
            if (this.proxies?.status().paused) this.resume();
            this.proxies?.prioritize(this.queuedIds);
            this.proxies?.retry(this.queuedIds);
            this.pending.push(...entries.filter(entry => !this.cancelledIds.has(entry.capture.shot.id)).map(entry => ({ entry, location: review.location })));
            if (!this.run) this.run = this.process(signal);
            this.wakeWorker?.();
            locked = []; // Worker owns the locks now.
            return structuredClone(this.state);
        } finally {
            if (locked.length) {
                this.scanner.unlockIngest(locked);
                this.queuedIds = this.queuedIds.filter(id => !locked.includes(id));
                this.state.total -= locked.length;
                if (!this.run) {
                    this.state.active = false;
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
        if (JSON.stringify(existing) !== JSON.stringify(entry.existing)) throw new Error('Library assets changed after review. Review the commit plan again to approve replacement.');
    }

    private async waitForWork(signal: AbortSignal) {
        if (signal.aborted) return;
        await new Promise<void>(resolve => {
            const wake = () => { signal.removeEventListener('abort', wake); if (this.wakeWorker === wake) this.wakeWorker = undefined; resolve(); };
            this.wakeWorker = wake;
            signal.addEventListener('abort', wake, { once: true });
        });
    }

    private async process(signal: AbortSignal) {
        try {
            while (!signal.aborted) {
                this.pending = this.pending.filter(item => !this.cancelledIds.has(item.entry.capture.shot.id));
                if (!this.pending.length && !this.preparing) break;
                const available = new Set(this.scanner.snapshot().shots.filter(shot => shot.available).map(shot => shot.id));
                const index = this.proxies ? this.pending.findIndex(({ entry }) => this.proxies!.readyFor(entry.capture.shot.id) || !available.has(entry.capture.shot.id)) : this.pending.length ? 0 : -1;
                if (index < 0) {
                    this.state.current = undefined; this.state.waiting = this.pending.length; this.publish();
                    await this.waitForWork(signal);
                    continue;
                }
                const { entry, location } = this.pending.splice(index, 1)[0];
                const { shot } = entry.capture;
                const controller = new AbortController();
                let finish!: () => void;
                const done = new Promise<void>(resolve => { finish = resolve; });
                this.activeTransfer = { id: shot.id, controller, done };
                const clipSignal = AbortSignal.any([signal, controller.signal]);
                this.state.waiting = 0;
                this.state.position++;
                this.state.current = { id: shot.id, filename: shot.filename, percent: 0, phase: 'transferring' };
                this.scanner.processingIngest(shot.id);
                this.publish();
                try {
                    await this.execute(entry, location, clipSignal);
                    this.state.current!.percent = 100;
                    this.state.completed = (this.state.completed ?? 0) + 1;
                    this.publish();
                } catch (error) {
                    if (!clipSignal.aborted) this.state.errors.push({ id: shot.id, filename: shot.filename,
                        message: error instanceof Error ? error.message : String(error), eventId: randomUUID() });
                    this.publish();
                } finally {
                    this.queuedIds = this.queuedIds.filter(id => id !== shot.id); this.scanner.unlockIngest([shot.id]);
                    this.proxies?.prioritize(this.queuedIds);
                    this.activeTransfer = undefined; finish();
                }
            }
        } finally {
            this.scanner.unlockIngest(this.queuedIds);
            this.queuedIds = [];
            this.pending = [];
            this.run = undefined;
            this.state.active = false;
            if (!signal.aborted) this.state.stopping = false;
            this.state.current = undefined; this.state.waiting = 0;
            this.publish();
        }
    }

    async cancel(ids: string[]) {
        if (this.closing) throw new Error('The app is closing.');
        // Cancel Commit snapshots only. Background proxy generation remains useful and editable.
        const selected = ids.filter(id => this.queuedIds.includes(id));
        const active = this.activeTransfer && selected.includes(this.activeTransfer.id) ? this.activeTransfer : undefined;
        selected.forEach(id => this.cancelledIds.add(id));
        this.pending = this.pending.filter(item => !selected.includes(item.entry.capture.shot.id));
        this.queuedIds = this.queuedIds.filter(id => !selected.includes(id));
        active?.controller.abort();
        this.scanner.unlockIngest(selected.filter(id => id !== active?.id));
        this.proxies?.prioritize(this.queuedIds);
        this.wakeWorker?.();
        if (this.review?.entries.some(entry => selected.includes(entry.capture.shot.id))) this.review = undefined;
        await Promise.all([this.preparing, active?.done]);
        // A publication that beat cancellation has already persisted its successful receipt.
        this.publish();
        return this.scanner.snapshot();
    }

    async eject(ids: string[]) {
        if (this.closing) throw new Error('The app is closing.');
        const unique = [...new Set(ids)];
        if (unique.some(id => this.queuedIds.includes(id) || this.activeTransfer?.id === id)) {
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

    private async execute(entry: Entry, location: LibraryLocation, signal: AbortSignal) {
        const { shot, path, fileIdentity, thumbnail, signature } = entry.capture;
        const validate = async () => {
            signal.throwIfAborted();
            await this.location(location);
            await this.scanner.validateIngest(shot.id, path, fileIdentity);
            signal.throwIfAborted();
        };
        await validate();
        await this.checkExisting(location, entry);
        const proxy = this.proxies ? await this.proxies.asset(shot.id) : null;
        const staging = await mkdtemp(join(tmpdir(), 'owmo-ingest-'));
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
                if (this.state.current && this.state.current.percent !== percent) {
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
                if (proxy && file.from === proxy.path && await libraryFileIdentity(proxy.path) !== proxy.identity) throw new Error('Scratch proxy changed before transfer.');
                const target = join(location.path, file.name);
                if (await libraryFileIdentity(target) !== entry.existing[file.name]) throw new Error('Destination changed after review.');
                await this.transfer(file.from, target, signal, percent => update(transferred + file.bytes * percent / 100), file.force);
                transferred += file.bytes;
            }
            await validate();
            this.state.current!.phase = 'metadata';
            this.state.current!.percent = 99;
            this.scanner.setTransferProgress(shot.id, 99);
            this.publish();
            const ingestedAt = new Date().toISOString();
            const metadata: LibraryMetadata = {
                id: shot.id, fingerprint: shot.fingerprint!, originalFilename: shot.filename, bytes: shot.bytes,
                recordedAt: shot.timestamp, dateSource: shot.dateSource, dateEvidence: shot.dateEvidence, dateConfidence: shot.dateConfidence,
                durationSeconds: shot.durationSeconds, metadata: shot.metadata, warnings: shot.warnings,
                ...ingestAttributes(shot.organization!), ingestion: { completedAt: ingestedAt, transfer: 'rsync' },
            };
            await writeFile(temporaryJSON, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', flush: true });
            await validate();
            if (await libraryFileIdentity(metadataPath) !== entry.existing[entry.names[2]]) throw new Error('Library metadata changed after review.');
            signal.throwIfAborted();
            await rename(temporaryJSON, metadataPath);
            // Publication is the completion boundary. A concurrent Stop must preserve this success.
            await this.scanner.markIngested(shot.id, { libraryPath: location.path, signature, ingestedAt });
            if (this.libraryRefresh?.path === location.path) this.libraryRefresh.published.set(shot.id, entry.names);
            await this.proxies?.published(shot.id, proxy, location.path);
        } finally {
            await unlink(temporaryJSON).catch(() => undefined);
            await rm(staging, { recursive: true, force: true });
        }
    }

    private async cancelTransfers() {
        this.review = undefined;
        this.controller?.abort();
        this.scanner.unlockIngest(this.queuedIds.filter(id => id !== this.state.current?.id));
        await this.preparing;
        await this.run;
        this.proxies?.prioritize([]);
    }

    async stop() {
        this.workGeneration++;
        this.state.stopping = true; this.publish();
        await Promise.all([this.cancelTransfers(), ...(this.proxies ? [this.proxies.stop(), this.scanner.pauseBackground()] : [])]);
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
        await this.libraryRefresh?.promise;
        clearTimeout(this.progressTimer);
        this.onChange = undefined;
    }
}
