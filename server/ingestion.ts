import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ingestAttributes } from '../shared/ingestion';
import type { IngestReview, IngestStatus } from '../shared/ingestion';
import { ShotScanner } from './scanner';
import { inspectLibrary, libraryAssetName, libraryFileIdentity, listLibrary, readLibraryAttributes } from './library';
import type { LibraryLocation, LibraryPresence } from './library';
import { rsyncFile } from './rsync';

type Capture = Awaited<ReturnType<ShotScanner['captureIngest']>>;
interface Entry {
    capture: Capture;
    names: [string, string, string];
    existing: Record<string, string | null>;
}
interface LibrarySnapshot extends LibraryPresence { location: LibraryLocation; names: string[] }
interface Review { token: string; location: LibraryLocation; entries: Entry[]; created: number }

export class IngestQueue {
    private review?: Review;
    private working = false;
    private closing = false;
    private run?: Promise<void>;
    private preparing?: Promise<void>;
    private controller?: AbortController;
    private queuedIds: string[] = [];
    private progressTimer?: ReturnType<typeof setTimeout>;
    private libraryScanVersion = 0;
    private libraryRefresh?: { path: string; promise: Promise<LibrarySnapshot | undefined> };
    onChange?: (status: IngestStatus) => void;
    private state: IngestStatus = { revision: 0, libraryPath: null, active: false, stopping: false, position: 0, total: 0, errors: [] };

    constructor(private scanner: ShotScanner, private configuredLibrary: () => Promise<string | null>,
        private inspect = inspectLibrary, private transfer = rsyncFile) {}

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
        const refresh = { path, promise: Promise.resolve(undefined) as Promise<LibrarySnapshot | undefined> };
        this.libraryRefresh = refresh;
        refresh.promise = (async () => {
            try {
                const location = await this.location();
                if (location.path !== path) throw new Error('The Library changed while checking it. Refresh the Library again.');
                const listing = await listLibrary(location);
                await this.location(location);
                if (!current()) return undefined;
                this.scanner.setLibraryPresence(path, listing);
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

    async revert(ids: string[]) {
        if (this.closing) throw new Error('The app is closing.');
        const unique = [...new Set(ids)];
        const location = await this.location();
        // This only restores local drafts. Scanner guards protect the selected clips;
        // unrelated transfers can continue using their immutable snapshots.
        return this.scanner.revertOrganization(unique, async () => {
            const attributes = [];
            for (const id of unique) attributes.push(await readLibraryAttributes(location, id));
            await this.location(location);
            return attributes;
        });
    }

    // Progress notifications are bounded and carry snapshots, avoiding HTTP/config reads.
    private publish(progress = false) {
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
        if (!configured) throw new Error('Set a Library location in Configuration before processing clips.');
        const location = await this.inspect(configured, this.scanner.sourceRoots());
        if (expected && JSON.stringify(location) !== JSON.stringify(expected)) throw new Error('The Library folder or mounted volume changed. Review the processing plan again.');
        return location;
    }

    private beginOperation() {
        if (this.closing || this.working || this.state.active) throw Object.assign(new Error('Wait for the current processing operation to finish.'), { statusCode: 409 });
        this.working = true;
    }

    private names(capture: Capture): Entry['names'] {
        const extension = extname(capture.shot.filename).toLowerCase();
        if (!/^\.[a-z0-9]+$/.test(extension)) throw new Error('Unsupported source filename extension.');
        return [libraryAssetName(capture.shot.id, 'source', extension.slice(1)), libraryAssetName(capture.shot.id, 'thumb', 'jpg'), libraryAssetName(capture.shot.id, 'metadata', 'json')];
    }

    private async existing(location: LibraryLocation, id: string, names: Entry['names'], listing?: string[]) {
        const files = listing ?? [];
        // A different extension would create two assets with the same role. Do not silently choose one.
        const unexpected = files.find(name => (name.startsWith(`${id}.source.`) || name.startsWith(`${id}.thumb.`)) && !names.includes(name) &&
            !name.endsWith('.partial') && /^[a-f0-9]{64}\.(?:source|thumb)\.[a-z0-9]+$/.test(name));
        if (unexpected) throw new Error(`Existing asset ${unexpected} uses a different extension. Resolve it before processing this clip.`);
        const entries = await Promise.all(names.map(async name => [name, await libraryFileIdentity(join(location.path, name))] as const));
        return Object.fromEntries(entries);
    }

    async preview(ids: string[]): Promise<IngestReview> {
        this.beginOperation();
        try {
            this.review = undefined;
            await this.status();
            const library = await this.scanLibrary();
            if (!library) throw new Error(this.state.libraryScan?.error ?? 'The Library could not be checked.');
            const { location, names: listing } = library;
            const entries: Entry[] = [];
            for (const id of [...new Set(ids)]) {
                const capture = await this.scanner.captureIngest(id);
                if (library.complete.has(id) && capture.shot.ingestion?.libraryPath === location.path && capture.shot.ingestion.signature === capture.signature) continue;
                const names = this.names(capture);
                entries.push({ capture, names, existing: await this.existing(location, id, names, listing) });
            }
            if (!entries.length) throw new Error('No clips need processing.');
            await this.location(location);
            this.review = { token: randomUUID(), location, entries, created: Date.now() };
            return { token: this.review.token, libraryPath: location.path, clips: entries.map(entry => ({
                id: entry.capture.shot.id, filename: entry.capture.shot.filename, bytes: entry.capture.shot.bytes + entry.capture.thumbnail.length,
                mode: Object.values(entry.existing).some(Boolean) ? 'replace' : 'new',
                files: entry.names.map((name, index) => ({ from: index === 0 ? entry.capture.path : index === 1 ? 'Current thumbnail' : 'Clip metadata', to: join(location.path, name) })),
            })) };
        } finally { this.working = false; }
    }

    async submit(token: string, ids: string[]) {
        this.beginOperation();
        let locked: string[] = [];
        let preparationFinished: (() => void) | undefined;
        try {
            const review = this.review;
            if (!review || token !== review.token || Date.now() - review.created > 30 * 60_000) throw new Error('The review expired. Review the processing plan again.');
            const unique = [...new Set(ids)];
            if (!unique.length || unique.some(id => !review.entries.some(entry => entry.capture.shot.id === id))) throw new Error('Invalid reviewed selection.');
            const entries = review.entries.filter(entry => unique.includes(entry.capture.shot.id));
            this.scanner.lockIngest(unique);
            locked = unique;
            this.controller = new AbortController();
            const signal = this.controller.signal;
            this.state = { ...this.state, active: true, stopping: false, position: 0, total: entries.length, current: undefined };
            this.publish();
            this.queuedIds = unique;
            this.preparing = new Promise(resolve => { preparationFinished = resolve; });
            await this.location(review.location);
            signal.throwIfAborted();
            const listing = await readdir(review.location.path);
            for (const entry of entries) {
                signal.throwIfAborted();
                const current = await this.scanner.captureIngest(entry.capture.shot.id);
                signal.throwIfAborted();
                if (current.signature !== entry.capture.signature || current.path !== entry.capture.path || current.fileIdentity !== entry.capture.fileIdentity) throw new Error('Clips changed since review. Review the processing plan again.');
                await this.checkExisting(review.location, entry, listing);
            }
            signal.throwIfAborted();
            this.review = undefined;
            this.run = this.process(entries, review.location, signal);
            locked = []; // Worker owns the locks now.
            return structuredClone(this.state);
        } finally {
            if (locked.length) {
                this.scanner.unlockIngest(locked);
                this.queuedIds = [];
                this.state.active = false;
                this.state.stopping = false;
                this.state.current = undefined;
                this.publish();
            }
            preparationFinished?.();
            this.preparing = undefined;
            this.working = false;
        }
    }

    private async checkExisting(location: LibraryLocation, entry: Entry, listing?: string[]) {
        const existing = await this.existing(location, entry.capture.shot.id, entry.names, listing);
        if (JSON.stringify(existing) !== JSON.stringify(entry.existing)) throw new Error('Library assets changed after review. Review the processing plan again to approve replacement.');
    }

    private async process(entries: Entry[], location: LibraryLocation, signal: AbortSignal) {
        try {
            for (let index = 0; index < entries.length && !signal.aborted; index++) {
                const entry = entries[index];
                const { shot } = entry.capture;
                this.state.position = index + 1;
                this.state.current = { id: shot.id, filename: shot.filename, percent: 0, phase: 'transferring' };
                this.scanner.processingIngest(shot.id);
                this.publish();
                try {
                    await this.execute(entry, location, signal);
                    this.state.current!.percent = 100;
                    this.publish();
                }
                catch (error) {
                    if (!signal.aborted) this.state.errors.push({ id: shot.id, filename: shot.filename,
                        message: error instanceof Error ? error.message : String(error), eventId: randomUUID() });
                    this.publish();
                } finally { this.queuedIds = this.queuedIds.filter(id => id !== shot.id); this.scanner.unlockIngest([shot.id]); }
            }
        } finally {
            this.scanner.unlockIngest(entries.map(entry => entry.capture.shot.id));
            this.queuedIds = [];
            this.state.active = false;
            this.state.stopping = false;
            this.state.current = undefined;
            this.publish();
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
        const staging = await mkdtemp(join(tmpdir(), 'owmo-ingest-'));
        const metadataPath = join(location.path, entry.names[2]);
        const temporaryJSON = join(location.path, `${shot.id}.metadata.${randomUUID()}.partial`);
        try {
            const stagedThumb = join(staging, entry.names[1]);
            await writeFile(stagedThumb, thumbnail, { mode: 0o600 });
            const totalBytes = shot.bytes + thumbnail.length;
            const update = (bytes: number) => {
                // Transfer bytes exclude metadata publication and the saved receipt.
                // Reserve 100% until the entire clip has finished successfully.
                const percent = Math.min(99, Math.round(bytes / Math.max(totalBytes, 1) * 100));
                if (this.state.current && this.state.current.percent !== percent) {
                    this.state.current.percent = percent;
                    this.publish(true);
                }
            };
            for (const [index, source] of [path, stagedThumb].entries()) {
                await validate();
                const target = join(location.path, entry.names[index]);
                if (await libraryFileIdentity(target) !== entry.existing[entry.names[index]]) throw new Error('Destination changed after review.');
                await this.transfer(source, target, signal, percent => update(index === 0 ? shot.bytes * percent / 100 : shot.bytes + thumbnail.length * percent / 100), index === 1);
            }
            await validate();
            this.state.current!.phase = 'metadata';
            this.state.current!.percent = 99;
            this.publish();
            const ingestedAt = new Date().toISOString();
            const metadata = {
                id: shot.id, fingerprint: shot.fingerprint, originalFilename: shot.filename, bytes: shot.bytes,
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
        } finally {
            await unlink(temporaryJSON).catch(() => undefined);
            await rm(staging, { recursive: true, force: true });
        }
    }

    async stop() {
        this.review = undefined;
        if (this.state.active) {
            this.state.stopping = true;
            this.publish();
            this.controller?.abort();
            this.scanner.unlockIngest(this.queuedIds.filter(id => id !== this.state.current?.id));
            await this.preparing;
            await this.run;
        }
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
