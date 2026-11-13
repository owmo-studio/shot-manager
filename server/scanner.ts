import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiscoveryRequest } from "../shared/shots";
import type { IngestionReceipt, IngestState, ProxyState } from "../shared/ingestion";
import { ingestionSignature } from './processingState';
export { ingestionSignature } from './processingState';
import type { ClipAttributes, OrganizationAction, TagVocabulary } from "../shared/organization";
import { organizationKey } from "../shared/organization";
import type { ShotChange, ShotCollection, ShotDetails, DiscoveryScan, VideoShot, VideoMetadata } from "../shared/shots";
import type { WorkspaceRestore } from "../shared/shots";
import type { DiscoveredShot } from "./discovery";
import { discoverShots } from "./discovery";
import { VideoFingerprintStore, videoFileVersion } from "./fingerprints";
import type { LibraryPresence } from "./library";
import { OrganizationStore } from "./organization";
import { ThumbnailQueue } from "./thumbnails";

interface ScanJob {
    request: DiscoveryRequest;
    status: DiscoveryScan;
    controller: AbortController;
    token: number;
    rootIdentity?: string;
    files?: string[];
}

// Workspace membership and file access outlive the scan that discovered a clip.
interface WorkspaceClip {
    result: DiscoveredShot;
    controller: AbortController;
    previewIdentity: string;
}

export class ShotScanner {
    private jobs = new Map<string, ScanJob>();
    private clips = new Map<string, WorkspaceClip>();
    private scanToken = 0;
    private directoryStates = new Map<string, { available: boolean; outage: number }>();
    private ejecting = new Set<string>();
    private ejectedAt = new Map<string, number>();
    private directoryCheck?: Promise<void>;
    private closed = false;
    private pending: Promise<void> = Promise.resolve();
    private revision = 0;
    private progressTimer?: ReturnType<typeof setTimeout>;
    onChange?: (change: ShotChange) => void;
    private vocabularyRevision = 0;
    private vocabularyKey = "";
    private thumbnailQueue?: ThumbnailQueue;
    private fingerprints: VideoFingerprintStore;
    readonly organization: OrganizationStore;
    private updatingThumbnails = new Set<string>();
    private clearingCache = false;
    private ingestLocks = new Map<string, "queued" | "processing">();
    private ingestLibrary: string | null = null;
    private libraryPresence: LibraryPresence | null = null;
    requireProxy = false;
    workPaused = false;
    private proxies = new Map<
        string,
        { proxyState: ProxyState; proxyPercent?: number; proxyError?: string; proxyLocation?: "cache" | "library" }
    >();
    private transferProgress = new Map<string, number>();
    private prepared = new Set<string>();

    libraryProxy(id: string) {
        return this.libraryPresence ? this.libraryPresence.proxies.has(id) : null;
    }
    proxyReady(id: string) {
        return this.proxies.get(id)?.proxyState === "ready";
    }
    setProxy(
        id: string,
        proxyState: ProxyState,
        proxyPercent?: number,
        proxyError?: string,
        proxyLocation?: "cache" | "library",
    ) {
        const next = { proxyState, proxyPercent, proxyError, proxyLocation };
        if (JSON.stringify(this.proxies.get(id)) === JSON.stringify(next)) return;
        this.proxies.set(id, next);
        this.publishProgress();
    }
    setTransferProgress(id: string, percent: number) {
        this.transferProgress.set(id, percent);
        this.publishProgress();
    }
    thumbnailsBusy() {
        return [...this.clips.values()].some(({ result }) => result.shot.thumbnailStatus === "pending");
    }
    async pauseBackground() {
        this.workPaused = true;
        await this.thumbnailQueue?.pause();
        for (const { result: { shot } } of this.clips.values()) if (shot.thumbnailStatus === "pending") shot.thumbnailStatus = undefined;
        this.publish();
    }
    resumeBackground() {
        this.workPaused = false;
        this.thumbnailQueue?.resume();
        for (const clip of this.clips.values()) this.queueThumbnail(clip);
        this.publish();
    }
    async proxyInput(id: string) {
        const { path, result } = await this.videoPath(id);
        return { path, fileIdentity: result.fileIdentity, shot: structuredClone(result.shot) };
    }

    assertNoIngestion() {
        if (this.ingestLocks.size)
            throw Object.assign(new Error("Cannot remove while queued; you must stop tasks."), {
                statusCode: 409,
            });
    }

    setIngestLibrary(path: string | null) {
        if (this.ingestLibrary === path) return;
        this.assertNoIngestion();
        this.ingestLibrary = path;
        this.libraryPresence = null;
        this.publish();
    }

    setLibraryPresence(path: string, presence: LibraryPresence | null) {
        if (path !== this.ingestLibrary) return;
        this.libraryPresence = presence
            ? {
                  existing: new Set(presence.existing),
                  complete: new Set(presence.complete),
                  proxies: new Set(presence.proxies),
              }
            : null;
        for (const [id, proxy] of this.proxies)
            if (proxy.proxyLocation === "library" && !presence?.proxies.has(id)) {
                this.proxies.set(id, { proxyState: presence ? "missing" : "unverified" });
            }
        this.publish();
    }

    lockIngest(ids: string[]) {
        if (this.clearingCache || this.updatingThumbnails.size)
            throw new Error("Wait for thumbnail changes to finish.");
        for (const id of ids) {
            const { result } = this.findShot(id);
            if (this.ingestLocks.has(id) || this.ejecting.has(id) || !result.shot.available)
                throw new Error("Clips are unavailable or already queued.");
        }
        ids.forEach((id) => this.ingestLocks.set(id, "queued"));
        this.publish();
    }

    commitLock(id: string) { return this.ingestLocks.get(id); }

    lockLibraryCommit(ids: string[]) {
        if (this.clearingCache || ids.some(id => this.ingestLocks.has(id) || this.ejecting.has(id) || this.updatingThumbnails.has(id))) throw new Error('Selected clips are locked.');
        ids.forEach(id => this.ingestLocks.set(id, 'queued'));
        this.publish();
    }

    canEditLibrary(ids: string[]) {
        return !this.closed && !this.clearingCache && ids.every(id => !this.ingestLocks.has(id) && !this.ejecting.has(id) && !this.updatingThumbnails.has(id));
    }

    cachedThumbnail(id: string, metadata: VideoMetadata) { return this.thumbnailQueue?.customByFingerprint(id, metadata) ?? Promise.resolve(null); }

    async replaceCachedThumbnails<T>(entries: { id: string; metadata: VideoMetadata; bytes: Buffer }[], save: (valid: () => boolean) => Promise<T>, current: () => boolean = () => true) {
        const ids = entries.map(entry => entry.id);
        if (!this.thumbnailQueue || !this.canEditLibrary(ids)) throw new Error('Selected clips are locked or thumbnail Cache is unavailable.');
        const clips = new Map(ids.map(id => [id, this.clips.get(id)]));
        ids.forEach(id => this.updatingThumbnails.add(id));
        const valid = () => !this.closed && !this.clearingCache && current() && ids.every(id => !this.ingestLocks.has(id) && !this.ejecting.has(id) && this.clips.get(id) === clips.get(id));
        let batch: Awaited<ReturnType<ThumbnailQueue['stageRevertImages']>> | undefined;
        try {
            batch = await this.thumbnailQueue.stageRevertImages(entries);
            await batch.commit(valid);
            const result = await save(valid);
            for (const entry of entries) {
                const clip = this.clips.get(entry.id);
                if (!clip) continue;
                Object.assign(clip.result.shot, { hasThumbnail: true, hasCustomThumbnail: true, thumbnailStatus: 'ready',
                    thumbnailDigest: createHash('sha256').update(entry.bytes).digest('hex'), thumbnailRevision: (clip.result.shot.thumbnailRevision ?? 0) + 1 });
                this.prepared.add(entry.id);
            }
            const completed = batch; batch = undefined; await completed.finish();
            this.publish(); return result;
        } catch (error) { await batch?.rollback(); throw error; }
        finally {
            ids.forEach(id => this.updatingThumbnails.delete(id));
            for (const id of ids) {
                const clip = this.clips.get(id);
                if (clip) { if (clip.result.shot.thumbnailStatus === 'pending') clip.result.shot.thumbnailStatus = undefined; this.queueThumbnail(clip); }
            }
        }
    }

    async reloadOrganizations() {
        const clips = [...this.clips.values()].filter(clip => clip.result.shot.fingerprint);
        const drafts = await this.organization.draftsFor(clips.map(clip => clip.result.shot.fingerprint!));
        let changed = false;
        for (const clip of clips) {
            if (this.clips.get(clip.result.shot.id) !== clip || this.ingestLocks.has(clip.result.shot.id)) continue;
            const record = drafts[organizationKey(clip.result.shot.fingerprint!)];
            if (record && (JSON.stringify(record.data) !== JSON.stringify(clip.result.shot.organization) || JSON.stringify(record.ingestion) !== JSON.stringify(clip.result.shot.ingestion))) {
                clip.result.shot.organization = record.data; clip.result.shot.ingestion = record.ingestion; changed = true;
            }
        }
        if (changed) this.publish();
    }

    retireCommitted(id: string) {
        this.ejectedAt.set(id, this.scanToken);
        this.dropClip(id);
        const used = new Set([...this.clips.values()].map(clip => dirname(clip.result.original)));
        for (const path of this.directoryStates.keys()) if (!used.has(path)) this.directoryStates.delete(path);
        this.publish();
    }

    processingIngest(id: string) {
        this.ingestLocks.set(id, "processing");
        this.publish();
    }
    unlockIngest(ids: string[]) {
        ids.forEach((id) => {
            this.ingestLocks.delete(id);
            this.transferProgress.delete(id);
        });
        this.publish();
    }

    async captureIngest(id: string) {
        const asset = await this.videoPath(id);
        const shot = structuredClone(asset.result.shot);
        if (
            this.clearingCache || this.ejecting.has(id) ||
            this.updatingThumbnails.has(id) ||
            !shot.organization ||
            !shot.fingerprint ||
            shot.organization.skipped
        )
            throw new Error("Clip is not ready to commit.");
        const image = await this.thumbnail(id);
        if (!image) throw new Error(`Thumbnail is unavailable for ${shot.filename}.`);
        const thumbnail = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
        shot.thumbnailDigest = createHash("sha256").update(thumbnail).digest("hex");
        asset.result.shot.thumbnailDigest = shot.thumbnailDigest;
        const signature = ingestionSignature(shot.organization, shot.thumbnailDigest);
        return { shot, path: asset.path, fileIdentity: asset.result.fileIdentity, thumbnail, signature };
    }

    async validateIngest(id: string, path: string, identity: string) {
        const asset = await this.videoPath(id);
        if (asset.path !== path || asset.result.fileIdentity !== identity)
            throw new Error("Source changed since review.");
    }

    async markIngested(id: string, receipt: IngestionReceipt) {
        const { result } = this.findShot(id);
        await this.organization.markIngested(result.shot.fingerprint!, receipt);
        if (receipt.libraryPath === this.ingestLibrary) {
            this.libraryPresence?.existing.add(id);
            this.libraryPresence?.complete.add(id);
            if (this.requireProxy) this.libraryPresence?.proxies.add(id);
        }
        result.shot.ingestion = structuredClone(receipt);
        this.publish();
    }

    mediaDirectories() {
        return [...new Set([
            ...[...this.clips.values()].map(({ result }) => dirname(result.original)),
            ...[...this.jobs.values()].filter(job => this.isBusy(job.request.id)).map(job => job.request.path),
        ])];
    }

    async cacheSummary() {
        return this.thumbnailQueue?.cacheSummary() ?? { bytes: 0, files: 0 };
    }

    async vocabulary(): Promise<TagVocabulary> {
        const options = await this.organization.vocabulary();
        // Only loaded clips contribute suggestions, including temporarily unavailable sources.
        options.tags = [
            ...new Set(
                [...this.clips.values()].flatMap(({ result: { shot } }) => shot.organization?.tags ?? []),
            ),
        ].sort();
        return options;
    }

    async localDataSummary() {
        const cache = await this.cacheSummary();
        const lists = await this.vocabulary();
        return {
            ...cache,
            options: lists.identity.length + lists.project.length + lists.tags.length,
            identities: lists.identity.length,
            projects: lists.project.length,
            tags: lists.tags.length,
            records: await this.organization.recordCount(),
            fingerprints: await this.fingerprints.recordCount(),
            clips: this.snapshot().shots.length,
        };
    }

    async clearLocalData() {
        this.assertNoIngestion();
        if (this.clearingCache || this.updatingThumbnails.size) {
            throw Object.assign(new Error("A thumbnail update is in progress. Try again shortly."), {
                statusCode: 409,
            });
        }
        this.clearingCache = true;
        try {
            for (const id of this.jobs.keys()) this.cancelScan(id, false);
            for (const clip of this.clips.values()) clip.controller.abort();
            this.clips.clear(); this.directoryStates.clear(); this.ejecting.clear(); this.ejectedAt.clear();
            this.publish();
            await this.pending;
            await this.thumbnailQueue?.clearCache();
            await this.fingerprints.reset();
            await this.organization.reset();
            this.prepared.clear();
            this.proxies.clear();
        } finally {
            this.clearingCache = false;
            this.publish();
        }
    }

    async clearCache() {
        this.assertNoIngestion();
        if (this.clearingCache || this.updatingThumbnails.size) {
            throw Object.assign(new Error("A thumbnail update is in progress. Try again shortly."), {
                statusCode: 409,
            });
        }
        this.clearingCache = true;
        try {
            await this.thumbnailQueue?.clearCache();
            await this.organization.clearThumbnailDrafts();
            return await this.cacheSummary();
        } finally {
            for (const { result: { shot } } of this.clips.values()) {
                shot.hasThumbnail = false;
                shot.hasCustomThumbnail = false;
                shot.thumbnailStatus = undefined;
                shot.thumbnailRevision = (shot.thumbnailRevision ?? 0) + 1;
            }
            this.clearingCache = false;
            for (const clip of this.clips.values()) this.queueThumbnail(clip);
            this.publish();
        }
    }

    constructor(
        thumbnailCacheDirectory?: string,
        fingerprintDirectory?: string,
        organizationFile?: string,
        assertWritable?: () => Promise<void>,
    ) {
        this.organization = new OrganizationStore(organizationFile, undefined, assertWritable);
        this.fingerprints = new VideoFingerprintStore(fingerprintDirectory, assertWritable);
        if (thumbnailCacheDirectory)
            this.thumbnailQueue = new ThumbnailQueue(thumbnailCacheDirectory, this.fingerprints, assertWritable);
    }

    private publish() {
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
        this.revision += 1;
        const tags = [
            ...new Set(
                [...this.clips.values()].flatMap(({ result: { shot } }) => shot.organization?.tags ?? []),
            ),
        ].sort();
        const vocabularyKey = JSON.stringify([this.organization.vocabularyRevision, tags]);
        if (vocabularyKey !== this.vocabularyKey) {
            this.vocabularyKey = vocabularyKey;
            this.vocabularyRevision++;
        }
        this.onChange?.({ revision: this.revision, vocabularyRevision: this.vocabularyRevision });
    }

    private publishProgress() {
        if (this.progressTimer) return;
        this.progressTimer = setTimeout(() => this.publish(), 100);
        this.progressTimer.unref();
    }

    discover(request: DiscoveryRequest, files?: string[]) { this.enqueue(request, files); }

    // Cancelling/discarding discovery does not eject the clips it already published.
    cancelScan(id: string, publish = true) {
        const job = this.jobs.get(id);
        if (!job) return;
        job.controller.abort();
        this.jobs.delete(id);
        if (publish) this.publish();
    }

    restoreFiles(paths: string[]) {
        const groups = new Map<string, string[]>();
        for (const path of new Set(paths)) {
            const directory = dirname(path);
            const files = groups.get(directory) ?? []; files.push(path); groups.set(directory, files);
        }
        for (const [path, files] of groups) this.enqueue({ id: randomUUID(), path }, files);
    }

    restorePlan(): WorkspaceRestore {
        const active = [...this.jobs.values()].filter(job => this.isBusy(job.request.id));
        return {
            files: [...this.clips.values()].filter(clip => clip.result.shot.available).map(clip => clip.result.original),
            scans: active.map(job => ({ path: job.request.path, files: job.files })),
            excludedIds: active.some(job => !job.files) ? [...this.ejectedAt.keys()].filter(id => !this.clips.has(id)) : [],
        };
    }

    restoreWorkspace(plan: WorkspaceRestore) {
        this.restoreFiles(plan.files);
        for (const scan of plan.scans) this.enqueue({ id: randomUUID(), path: scan.path }, scan.files);
        for (const id of plan.excludedIds) this.ejectedAt.set(id, this.scanToken);
    }

    private enqueue(request: DiscoveryRequest, files?: string[]) {
        if (this.closed) return;
        this.cancelScan(request.id, false);
        const job: ScanJob = {
            request, files, status: { discoveryId: request.id, path: request.path, state: "queued", clipCount: 0, warnings: [] },
            controller: new AbortController(), token: ++this.scanToken,
        };
        this.jobs.set(request.id, job);
        this.publish();
        this.pending = this.pending.catch(() => undefined).then(async () => {
            if (job.controller.signal.aborted) return;
            job.status.state = "scanning"; this.publish();
            try {
                const root = await stat(request.path);
                job.rootIdentity = `${root.dev}:${root.ino}:${root.birthtimeMs}`;
                await discoverShots(request, job.controller.signal, async result => {
                    try {
                        result.shot.fingerprint = await this.fingerprints.identify(result.original, job.controller.signal);
                        if (!await this.fileMatches(result)) throw new Error("Video changed after metadata discovery.");
                    } catch (error) {
                        job.controller.signal.throwIfAborted();
                        if (job.status.warnings.length < 100) job.status.warnings.push(`Could not fingerprint ${result.shot.filename}. ${error instanceof Error ? error.message : "Fingerprint unavailable."} File was skipped; add this folder again to retry.`);
                        return;
                    }
                    result.shot.id = result.shot.fingerprint.value;
                    try {
                        result.shot.organization = await this.organization.scanned(result.shot.fingerprint, job.controller.signal, { name: result.shot.filename, path: result.original });
                        result.shot.ingestion = await this.organization.ingestion(result.shot.fingerprint);
                    } catch {
                        job.controller.signal.throwIfAborted();
                        if (job.status.warnings.length < 100) job.status.warnings.push(`Could not load attributes for ${result.shot.filename}. Saved data has been preserved. File was skipped; add this folder again to retry.`);
                        return;
                    }
                    try { await this.thumbnailQueue?.touch(result.original, job.rootIdentity ?? "", result.shot.metadata); }
                    catch { job.controller.signal.throwIfAborted(); }
                    job.controller.signal.throwIfAborted();
                    if (this.jobs.get(request.id) !== job) return;
                    await this.admitClip(result, job);
                    const active = this.clips.get(result.shot.id);
                    if (active && active.result.original !== result.original) {
                        await this.organization.scanned(result.shot.fingerprint!, job.controller.signal, {
                            name: active.result.shot.filename, path: active.result.original,
                        });
                    }
                    job.controller.signal.throwIfAborted();
                    job.status.clipCount++;
                    this.publishProgress();
                }, message => { if (job.status.warnings.length < 100) job.status.warnings.push(message); }, job.files);
                await this.organization.flushScans();
                const currentRoot = await stat(request.path);
                if (`${currentRoot.dev}:${currentRoot.ino}:${currentRoot.birthtimeMs}` !== job.rootIdentity) throw new Error("Folder replaced during scan");
                job.controller.signal.throwIfAborted();
                job.status.state = "complete";
            } catch {
                if (!job.controller.signal.aborted) {
                    job.status.state = "failed";
                    job.status.error = "Scan interrupted. Some clips may not have been discovered.";
                }
            } finally {
                if (this.jobs.get(request.id) === job) this.publish();
            }
        });
    }

    private async admitClip(result: DiscoveredShot, job: ScanJob) {
        const id = result.shot.id;
        if (this.ejecting.has(id) || (this.ejectedAt.get(id) ?? -1) >= job.token) return;
        for (const [otherId, clip] of this.clips) {
            if (otherId !== id && clip.result.original === result.original) this.setAvailable(clip, false);
        }
        const current = this.clips.get(id);
        const keep = current && (this.ingestLocks.has(id) || await this.fileMatches(current.result));
        job.controller.signal.throwIfAborted();
        if (this.jobs.get(job.request.id) !== job || this.ejecting.has(id) || (this.ejectedAt.get(id) ?? -1) >= job.token) return;
        if (current && keep) {
            // Rediscovery is idempotent; edits and the chosen path stay on the workspace record.
            if (!this.ingestLocks.has(id)) this.setAvailable(current, true);
            this.queueThumbnail(current);
            return;
        }
        if (current) {
            current.controller.abort();
            // Drafts may have been edited while discovery was awaiting metadata or cache I/O.
            result.shot.organization = current.result.shot.organization;
            result.shot.ingestion = current.result.shot.ingestion;
            result.shot.hasCustomThumbnail = current.result.shot.hasCustomThumbnail;
            result.shot.thumbnailRevision = (current.result.shot.thumbnailRevision ?? 0) + 1;
        }
        result.shot.filePath = result.original;
        const clip: WorkspaceClip = { result, controller: new AbortController(), previewIdentity: job.rootIdentity ?? "" };
        this.clips.set(id, clip);
        this.prepared.delete(id);
        this.queueThumbnail(clip);
    }

    isBusy(id: string): boolean {
        const state = this.jobs.get(id)?.status.state;
        return state === "queued" || state === "scanning";
    }

    async updateOrganization(ids: string[], action: OrganizationAction) {
        const targets = [...new Set(ids)].map((id) => this.findShot(id));
        const valid = () =>
            targets.every(
                ({ clip, result }) =>
                    this.clips.get(result.shot.id) === clip &&
                    !this.ingestLocks.has(result.shot.id) && !this.ejecting.has(result.shot.id) &&
                    !!result.shot.fingerprint &&
                    !!result.shot.organization,
            );
        if (!valid())
            throw Object.assign(new Error("Selected clips are locked or their drafts are unavailable."), {
                statusCode: 409,
            });
        const changed = await this.organization.update(
            targets.map(({ result }) => result.shot.fingerprint!),
            action,
            valid,
        );
        for (const { result: { shot } } of this.clips.values()) {
            if (shot.fingerprint) {
                const data = changed.drafts[organizationKey(shot.fingerprint)];
                if (data) shot.organization = structuredClone(data);
            }
        }
        this.publish();
        return { collection: this.snapshot(), vocabulary: await this.vocabulary() };
    }

    async revertOrganization(ids: string[], read: () => Promise<{ attributes: ClipAttributes; thumbnail: Buffer }[]>) {
        const targets = [...new Set(ids)].map(id => {
            const asset = this.findShot(id);
            return { ...asset, organization: JSON.stringify(asset.result.shot.organization), revision: asset.result.shot.thumbnailRevision };
        });
        const valid = () => !this.closed && !this.clearingCache && targets.every(({ clip, result, organization, revision }) =>
            this.clips.get(result.shot.id) === clip && !this.ingestLocks.has(result.shot.id) && !this.ejecting.has(result.shot.id) &&
            !!result.shot.fingerprint && !!result.shot.organization && result.shot.thumbnailRevision === revision &&
            JSON.stringify(result.shot.organization) === organization);
        if (!targets.length || !valid() || targets.some(({ result }) => this.updatingThumbnails.has(result.shot.id)))
            throw new Error('Selected clips are locked or their attributes are unavailable.');
        if (!this.thumbnailQueue) throw new Error('Thumbnail cache is unavailable.');
        targets.forEach(({ result }) => this.updatingThumbnails.add(result.shot.id));
        let images: Awaited<ReturnType<ThumbnailQueue['stageRevertImages']>> | undefined;
        let committed = false;
        try {
            const assets = await read();
            if (!valid()) throw new Error('Selected clips changed. Try Revert again.');
            if (assets.length !== targets.length) throw new Error('Library assets are incomplete.');
            images = await this.thumbnailQueue.stageRevertImages(targets.map(({ result }, index) => ({
                id: result.shot.id, metadata: result.shot.metadata, bytes: assets[index].thumbnail,
            })));
            await images.commit(valid);
            const changed = await this.organization.restore(targets.map(({ result }, index) => ({
                fingerprint: result.shot.fingerprint!, attributes: assets[index].attributes,
            })), valid);
            committed = true;
            for (const { result: { shot } } of this.clips.values()) if (shot.fingerprint) {
                const data = changed.drafts[organizationKey(shot.fingerprint)];
                if (data) shot.organization = structuredClone(data);
            }
            targets.forEach(({ result: { shot } }, index) => {
                shot.thumbnailDigest = createHash('sha256').update(assets[index].thumbnail).digest('hex');
                shot.hasCustomThumbnail = true; shot.hasThumbnail = true; shot.thumbnailStatus = 'ready';
                shot.thumbnailRevision = (shot.thumbnailRevision ?? 0) + 1;
                this.prepared.add(shot.id);
            });
            await images.finish().catch(() => undefined); // Unremoved backups are disposable Cache files.
            this.publish();
            return { collection: this.snapshot(), vocabulary: await this.vocabulary() };
        } catch (error) {
            if (images && !committed) {
                try { await images.rollback(); }
                catch { throw new Error('Revert failed and thumbnail rollback could not finish. Cache recovery files were kept.'); }
            }
            throw error;
        } finally {
            targets.forEach(({ clip, result: { shot } }) => {
                this.updatingThumbnails.delete(shot.id);
                if (shot.thumbnailStatus === 'pending') {
                    shot.thumbnailRevision = (shot.thumbnailRevision ?? 0) + 1;
                    shot.thumbnailStatus = undefined; this.queueThumbnail(clip);
                }
            });
        }
    }

    private optionsEditable = () =>
        ![...this.jobs.keys()].some((id) => this.isBusy(id)) && !this.clearingCache && !this.ingestLocks.size;

    private activeDraftKeys() {
        return new Set(
            [...this.clips.values()].flatMap(({ result: { shot } }) => shot.fingerprint ? [organizationKey(shot.fingerprint)] : []),
        );
    }

    previewOptions(removals: TagVocabulary) {
        if (!this.optionsEditable())
            throw Object.assign(new Error("Wait for scanning to finish, then save again."), { statusCode: 409 });
        return this.organization.previewOptions(removals, this.activeDraftKeys());
    }

    async removeOptions(removals: TagVocabulary, reviewToken: string) {
        if (!this.optionsEditable())
            throw Object.assign(new Error("Wait for scanning to finish, then save again."), { statusCode: 409 });
        const changed = await this.organization.removeOptions(
            removals,
            reviewToken,
            this.optionsEditable,
            this.activeDraftKeys(),
        );
        for (const { result: { shot } } of this.clips.values()) {
            if (shot.fingerprint) {
                const data = changed.drafts[organizationKey(shot.fingerprint)];
                if (data) shot.organization = structuredClone(data);
            }
        }
        this.publish();
        return { vocabulary: await this.vocabulary(), collection: this.snapshot() };
    }

    isEjecting(id: string) { return this.ejecting.has(id); }

    beginEject(ids: string[]) {
        if (this.closed || this.clearingCache) throw new Error("Wait for Cache work to finish before ejecting clips.");
        if (ids.some(id => this.ejecting.has(id))) throw new Error("Some clips are already being ejected.");
        for (const id of ids) {
            this.ejectedAt.set(id, this.scanToken);
            this.ejecting.add(id);
            this.clips.get(id)?.controller.abort();
        }
        this.publish();
    }

    async settleEject(ids: string[]) {
        const signals = ids.flatMap(id => this.clips.has(id) ? [this.clips.get(id)!.controller.signal] : []);
        await this.thumbnailQueue?.waitFor(signals);
    }

    finishEject(ids: string[]) {
        if (ids.some(id => this.ingestLocks.has(id))) throw new Error("Wait for the clips' Commit work to stop.");
        for (const id of ids) { this.dropClip(id); this.ejecting.delete(id); }
        const used = new Set([...this.clips.values()].map(clip => dirname(clip.result.original)));
        for (const path of this.directoryStates.keys()) if (!used.has(path)) this.directoryStates.delete(path);
        this.publish();
        return this.snapshot();
    }

    abortEject(ids: string[]) {
        for (const id of ids) this.ejecting.delete(id);
        this.publish();
    }

    private dropClip(id: string) {
        this.clips.get(id)?.controller.abort();
        this.clips.delete(id); this.prepared.delete(id); this.proxies.delete(id); this.transferProgress.delete(id);
    }

    private ingestState(shot: VideoShot): IngestState | undefined {
        const locked = this.ingestLocks.get(shot.id);
        if (locked) return locked;
        const receipt = shot.ingestion?.libraryPath === this.ingestLibrary ? shot.ingestion : undefined;
        if (!this.libraryPresence) return receipt ? "unverified" : undefined;
        // Presence determines New versus Update, even without a local receipt.
        // Only a complete asset set and matching receipt can prove Synced.
        if (!this.libraryPresence.existing.has(shot.id)) return undefined;
        return this.libraryPresence.complete.has(shot.id) &&
            (!this.requireProxy || this.libraryPresence.proxies.has(shot.id)) &&
            receipt &&
            shot.organization &&
            shot.thumbnailDigest &&
            receipt.signature === ingestionSignature(shot.organization, shot.thumbnailDigest)
            ? "synced"
            : "changes-pending";
    }

    snapshot(): ShotCollection {
        return {
            revision: this.revision,
            shots: [...this.clips.values()].map(clip => ({
                ...clip.result.shot,
                filePath: clip.result.original,
                editable: !this.ingestLocks.has(clip.result.shot.id) && !this.ejecting.has(clip.result.shot.id) &&
                    (!this.thumbnailQueue || this.prepared.has(clip.result.shot.id) || clip.result.shot.hasThumbnail),
                ingestState: this.ingestState(clip.result.shot),
                ...this.proxies.get(clip.result.shot.id),
                transferPercent: this.transferProgress.get(clip.result.shot.id),
            }))
                .sort(
                    (first, second) =>
                        first.timestamp.slice(0, 10).localeCompare(second.timestamp.slice(0, 10)) ||
                        Date.parse(first.timestamp) - Date.parse(second.timestamp) ||
                        first.id.localeCompare(second.id),
                ),
            directories: this.directoryAvailability(),
            scans: [...this.jobs.values()].map((job) => ({ ...job.status, warnings: [...job.status.warnings] })),
        };
    }

    private findShot(id: string) {
        const clip = this.clips.get(id);
        if (!clip) throw Object.assign(new Error("Clip is no longer available."), { statusCode: 404 });
        return { clip, result: clip.result };
    }

    directoryAvailability() {
        const groups = new Map<string, string[]>();
        for (const [id, clip] of this.clips) {
            if (this.ejecting.has(id)) continue;
            const path = dirname(clip.result.original);
            const ids = groups.get(path) ?? []; ids.push(id); groups.set(path, ids);
        }
        return [...groups].map(([path, clipIds]) => ({ path, clipIds,
            available: this.directoryStates.get(path)?.available ?? true,
            outage: this.directoryStates.get(path)?.outage ?? 0,
        }));
    }

    private async fileMatches(result: DiscoveredShot) {
        try {
            if (await realpath(result.original) !== result.original) return false;
            const info = await stat(result.original);
            return info.isFile() && videoFileVersion(info) === result.fileIdentity;
        } catch { return false; }
    }

    private setAvailable(clip: WorkspaceClip, available: boolean, publish = true) {
        if (this.clips.get(clip.result.shot.id) !== clip || this.ejecting.has(clip.result.shot.id) || clip.result.shot.available === available) return false;
        clip.result.shot.available = available;
        if (!available) {
            clip.controller.abort();
            if (clip.result.shot.thumbnailStatus === "pending") clip.result.shot.thumbnailStatus = undefined;
        } else {
            clip.controller = new AbortController();
            if (clip.result.shot.thumbnailStatus === "failed") clip.result.shot.thumbnailStatus = undefined;
            this.queueThumbnail(clip);
        }
        if (publish) this.publish();
        return true;
    }

    // Poll only the unique containing directories; inspect individual files on recovery/access.
    checkDirectories(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.directoryCheck) return this.directoryCheck;
        const groups = new Map<string, WorkspaceClip[]>();
        for (const clip of this.clips.values()) {
            const directory = dirname(clip.result.original);
            const members = groups.get(directory) ?? []; members.push(clip); groups.set(directory, members);
        }
        for (const directory of this.directoryStates.keys()) if (!groups.has(directory)) this.directoryStates.delete(directory);
        let changed = false;
        const checking = Promise.all([...groups].map(async ([directory, clips]) => {
            let available = false;
            try { available = (await stat(directory)).isDirectory(); } catch { /* Missing/inaccessible directory. */ }
            if (this.closed || !clips.some(clip => this.clips.get(clip.result.shot.id) === clip)) return;
            const previous = this.directoryStates.get(directory);
            if (previous?.available !== available) changed = true;
            this.directoryStates.set(directory, { available, outage: (previous?.outage ?? 0) + (!available && previous?.available !== false ? 1 : 0) });
            for (const clip of clips) {
                if (!available) changed = this.setAvailable(clip, false, false) || changed;
                else if (previous?.available === false) changed = this.setAvailable(clip, await this.fileMatches(clip.result), false) || changed;
            }
        })).then(() => { if (changed && !this.closed) this.publish(); }).finally(() => { if (this.directoryCheck === checking) this.directoryCheck = undefined; });
        this.directoryCheck = checking;
        return checking;
    }

    private async videoPath(id: string) {
        const { clip, result } = this.findShot(id);
        const matches = await this.fileMatches(result);
        if (this.clips.get(id) !== clip || !matches) {
            this.setAvailable(clip, false);
            throw Object.assign(new Error("Source or file is no longer accessible."), { statusCode: 410 });
        }
        this.setAvailable(clip, true);
        return { path: result.original, clip, result };
    }

    async openVideo(id: string) {
        const asset = await this.videoPath(id);
        let file: FileHandle | undefined;
        try {
            file = await open(asset.path, "r");
            const info = await file.stat();
            if (
                !info.isFile() ||
                videoFileVersion(info) !==
                    asset.result.fileIdentity ||
                this.clips.get(id) !== asset.clip ||
                !asset.result.shot.available
            ) {
                await file.close();
                throw new Error("Asset changed");
            }
            return { file, path: asset.path };
        } catch {
            await file?.close().catch(() => undefined);
            throw Object.assign(new Error("Video is no longer accessible."), { statusCode: 410 });
        }
    }

    async details(id: string): Promise<ShotDetails> {
        const { clip, result } = this.findShot(id);
        const details: ShotDetails = {
            file: { filename: result.shot.filename, path: result.original, bytes: result.shot.bytes },
            metadata: result.shot.metadata,
            fingerprint: result.shot.fingerprint,
            embeddedMetadata: result.embeddedMetadata,
            mediaInfo: result.mediaInfo ?? null,
            errors: [],
        };
        try {
            const asset = await this.videoPath(id);
            details.file.bytes = (await stat(asset.path)).size;
            details.file.path = asset.path;
        } catch {
            details.errors.push("The video file could not be read.");
        }
        return details;
    }

    private thumbnailCurrent(clip: WorkspaceClip, revision: number | undefined) {
        return !this.closed && !this.clearingCache && this.clips.get(clip.result.shot.id) === clip && clip.result.shot.available &&
            !clip.controller.signal.aborted && !this.ejecting.has(clip.result.shot.id) && !this.updatingThumbnails.has(clip.result.shot.id) && clip.result.shot.thumbnailRevision === revision;
    }

    private async thumbnailSourceValid(clip: WorkspaceClip, revision: number | undefined) {
        if (!this.thumbnailCurrent(clip, revision)) return false;
        return await this.fileMatches(clip.result) && this.thumbnailCurrent(clip, revision);
    }

    // Thumbnail work belongs to a clip, independently of discovery job lifetime.
    private queueThumbnail(clip: WorkspaceClip) {
        if (this.workPaused) return;
        const { result } = clip;
        const revision = result.shot.thumbnailRevision;
        if (!this.thumbnailQueue || !this.thumbnailCurrent(clip, revision) || result.shot.thumbnailStatus) return;
        result.shot.thumbnailStatus = "pending";
        const valid = () => this.thumbnailSourceValid(clip, revision);
        this.thumbnailQueue.enqueue([result.original], clip.previewIdentity, clip.controller.signal, valid, image => {
            if (!this.thumbnailCurrent(clip, revision)) return;
            result.shot.thumbnailStatus = image ? "ready" : "failed";
            this.prepared.add(result.shot.id);
            result.shot.hasThumbnail = !!image;
            if (image) result.shot.thumbnailDigest = createHash("sha256").update(Buffer.from(image.slice(image.indexOf(",") + 1), "base64")).digest("hex");
            this.publishProgress();
        }, result.shot.metadata);
    }

    async thumbnail(id: string): Promise<string | null> {
        if (!this.thumbnailQueue || this.clearingCache) return null;
        const clip = this.clips.get(id);
        if (!clip) return null;
        const revision = clip.result.shot.thumbnailRevision;
        if (!await this.thumbnailSourceValid(clip, revision)) return null;
        const image = await this.thumbnailQueue.image(clip.result.original, clip.previewIdentity, clip.result.shot.metadata);
        return image && await this.thumbnailSourceValid(clip, revision) ? image : null;
    }

    async setThumbnail(id: string, dataUrl: string) {
        if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Invalid thumbnail.');
        if (!this.canEditLibrary([id])) throw new Error('Clip is queued for a Library commit or being ejected.');
        const asset = await this.videoPath(id);
        const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        await this.replaceCachedThumbnails([{ id, metadata: asset.result.shot.metadata, bytes }], async valid => {
            if (!await this.fileMatches(asset.result) || !valid()) throw new Error('Source changed while updating the thumbnail.');
            const digest = createHash('sha256').update(bytes).digest('hex');
            await this.organization.setThumbnailDraft(asset.result.shot.fingerprint!, { digest, revision: Date.now() }, valid);
        });
    }

    async close() {
        this.closed = true;
        this.onChange = undefined;
        clearTimeout(this.progressTimer);
        for (const id of this.jobs.keys()) this.cancelScan(id, false);
        for (const clip of this.clips.values()) clip.controller.abort();
        await this.directoryCheck;
        await this.thumbnailQueue?.close();
        await this.pending;
        await this.organization
            .flushScans()
            .catch((error) => console.warn("Scan bookkeeping could not be saved; existing drafts preserved.", error));
        await this.organization
            .prune()
            .catch((error) => console.warn("Draft retention cleanup failed; saved drafts preserved.", error));
    }
}
