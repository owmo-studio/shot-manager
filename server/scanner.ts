import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ImportSource } from "../shared/desktop";
import type { ShotChange, ShotCollection, ShotDetails, SourceScan } from "../shared/shots";
import { discoverShots } from "./discovery";
import type { DiscoveredShot } from "./discovery";
import { ThumbnailQueue } from "./thumbnails";
import { VideoFingerprintStore } from "./fingerprints";
import { OrganizationStore } from "./organization";
import { organizationKey } from "../shared/organization";
import type { OrganizationAction, TagVocabulary } from "../shared/organization";

interface ScanJob {
    source: ImportSource;
    status: SourceScan;
    controller: AbortController;
    shots: DiscoveredShot[];
    rootIdentity?: string;
    refreshing: boolean;
    confirmed: Set<DiscoveredShot>;
}

export class ShotScanner {
    private jobs = new Map<string, ScanJob>();
    private pending: Promise<void> = Promise.resolve();
    private revision = 0;
    private progressTimer?: ReturnType<typeof setTimeout>;
    onChange?: (change: ShotChange) => void;
    private vocabularyRevision = 0;
    private vocabularyKey = '';
    private thumbnailQueue?: ThumbnailQueue;
    private fingerprints: VideoFingerprintStore;
    readonly organization: OrganizationStore;
    private updatingThumbnails = new Set<string>();
    private clearingCache = false;

    async cacheSummary() {
        return this.thumbnailQueue?.cacheSummary() ?? { bytes: 0, files: 0 };
    }

    async vocabulary(): Promise<TagVocabulary> {
        const options = await this.organization.vocabulary();
        // Only loaded clips contribute suggestions, including temporarily unavailable sources.
        options.tags = [...new Set([...this.jobs.values()].flatMap(job =>
            job.shots.flatMap(({ shot }) => shot.organization?.tags ?? [])))].sort();
        return options;
    }

    async localDataSummary() {
        const cache = await this.cacheSummary();
        const lists = await this.vocabulary();
        return { ...cache, options: lists.identity.length + lists.project.length + lists.tags.length,
            identities: lists.identity.length, projects: lists.project.length, tags: lists.tags.length,
            records: await this.organization.recordCount(), fingerprints: await this.fingerprints.recordCount(),
            clips: this.snapshot().shots.length };
    }

    async clearLocalData() {
        if (this.clearingCache || this.updatingThumbnails.size) {
            throw Object.assign(new Error("A thumbnail update is in progress. Try again shortly."), { statusCode: 409 });
        }
        this.clearingCache = true;
        try {
            for (const id of this.jobs.keys()) this.remove(id, false);
            this.publish();
            await this.pending;
            await this.thumbnailQueue?.clearCache();
            await this.fingerprints.reset();
            await this.organization.reset();
        } finally {
            this.clearingCache = false;
            this.publish();
        }
    }

    async clearCache() {
        if (this.clearingCache || this.updatingThumbnails.size) {
            throw Object.assign(new Error("A thumbnail update is in progress. Try again shortly."), { statusCode: 409 });
        }
        this.clearingCache = true;
        try {
            await this.thumbnailQueue?.clearCache();
            return await this.cacheSummary();
        } finally {
            for (const job of this.jobs.values()) for (const { shot } of job.shots) {
                shot.hasThumbnail = false;
                shot.hasCustomThumbnail = false;
                shot.thumbnailStatus = undefined;
                shot.thumbnailRevision = (shot.thumbnailRevision ?? 0) + 1;
            }
            this.clearingCache = false;
            for (const job of this.jobs.values()) for (const result of job.shots) this.queueThumbnail(job, result);
            this.publish();
        }
    }

    constructor(thumbnailCacheDirectory?: string, fingerprintDirectory?: string, organizationFile?: string) {
        this.organization = new OrganizationStore(organizationFile);
        this.fingerprints = new VideoFingerprintStore(fingerprintDirectory);
        if (thumbnailCacheDirectory) this.thumbnailQueue = new ThumbnailQueue(thumbnailCacheDirectory, this.fingerprints);
    }

    private publish() {
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
        this.revision += 1;
        const tags = [...new Set([...this.jobs.values()].flatMap(job =>
            job.shots.flatMap(({shot}) => shot.organization?.tags ?? [])))].sort();
        const vocabularyKey = JSON.stringify([this.organization.vocabularyRevision, tags]);
        if (vocabularyKey !== this.vocabularyKey) { this.vocabularyKey = vocabularyKey; this.vocabularyRevision++; }
        this.onChange?.({ revision: this.revision, vocabularyRevision: this.vocabularyRevision });
    }

    private publishProgress() {
        if (this.progressTimer) return;
        this.progressTimer = setTimeout(() => this.publish(), 100);
        this.progressTimer.unref();
    }

    sync(sources: ImportSource[]) {
        const registered = new Set(sources.map((source) => source.id));
        for (const id of this.jobs.keys()) if (!registered.has(id)) this.remove(id);
        for (const source of sources) {
            const job = this.jobs.get(source.id);
            if (job) {
                const availabilityChanged = job.source.available !== source.available;
                job.source = source;
                if (!source.available && (job.status.state === "queued" || job.status.state === "scanning")) {
                    job.status.state = "interrupted";
                    job.status.clipCount = job.shots.length;
                    job.status.error = "Scan interrupted because the source became unavailable. Previously discovered clips have been retained.";
                    job.controller.abort();
                }
                if (availabilityChanged) {
                    if (source.available) for (const result of job.shots) this.queueThumbnail(job, result);
                    this.publish();
                }
            } else if (source.available) {
                this.schedule(source);
            }
        }
    }

    schedule(source: ImportSource) {
        if (this.jobs.has(source.id)) return;
        this.enqueue(source);
    }

    refresh(source: ImportSource) {
        this.enqueue(source, this.jobs.get(source.id));
    }

    private enqueue(source: ImportSource, previous?: ScanJob) {
        this.remove(source.id, false);
        const job: ScanJob = {
            source,
            status: { sourceId: source.id, state: "queued", clipCount: 0, warnings: [] },
            controller: new AbortController(),
            shots: [...(previous?.shots ?? [])],
            rootIdentity: previous?.rootIdentity,
            refreshing: !!previous,
            confirmed: new Set(),
        };
        for (const result of job.shots) {
            if (result.shot.thumbnailStatus === "pending" || result.shot.thumbnailStatus === "failed") result.shot.thumbnailStatus = undefined;
        }
        this.jobs.set(source.id, job);
        this.publish();
        this.pending = this.pending.then(async () => {
            if (job.controller.signal.aborted) return;
            job.status.state = "scanning";
            this.publish();
            const discovered: DiscoveredShot[] = [];
            try {
                const root = await stat(source.path);
                job.rootIdentity = `${root.dev}:${root.ino}:${root.birthtimeMs}`;
                await discoverShots(source, job.controller.signal, async (shot) => {
                    try {
                        shot.shot.fingerprint = await this.fingerprints.identify(shot.original, job.controller.signal);
                        const current = await stat(shot.original);
                        if ([current.dev, current.ino, current.birthtimeMs, current.size, current.mtimeMs].join(":") !== shot.fileIdentity) {
                            throw new Error("Video changed after metadata discovery.");
                        }
                    } catch (error) {
                        job.controller.signal.throwIfAborted();
                        if (job.status.warnings.length < 100) job.status.warnings.push(`Could not fingerprint ${shot.shot.filename}. ${error instanceof Error ? error.message : 'Fingerprint unavailable.'} File was skipped; refresh this source to retry.`);
                        return;
                    }
                    shot.shot.id = shot.shot.fingerprint.value;
                    try {
                        shot.shot.organization = await this.organization.scanned(shot.shot.fingerprint, job.controller.signal, { name: shot.shot.filename, path: shot.original });
                    } catch {
                        job.controller.signal.throwIfAborted();
                        if (job.status.warnings.length < 100) job.status.warnings.push(`Could not load attributes for ${shot.shot.filename}. Saved data has been preserved. File was skipped; refresh this source to retry.`);
                        return;
                    }
                    // Preview failures must not prevent a fully identified clip from appearing.
                    try { await this.thumbnailQueue?.touch(shot.original, job.rootIdentity ?? "", shot.shot.metadata); }
                    catch { job.controller.signal.throwIfAborted(); }
                    const old = previous?.shots.find((result) => result.shot.id === shot.shot.id);
                    if (old) {
                        shot.shot.thumbnailRevision = old.shot.thumbnailRevision ?? 0;
                        if (old.fileIdentity === shot.fileIdentity) shot.shot.hasThumbnail ||= old.shot.hasThumbnail;
                        else shot.shot.thumbnailRevision += 1;
                    }
                    if (old?.fileIdentity === shot.fileIdentity) {
                        this.thumbnailQueue?.rememberLegacyLocation(old.fileIdentity, old.original, previous?.rootIdentity ?? "");
                    }
                    job.controller.signal.throwIfAborted();
                    discovered.push(shot);
                    const existingIndex = previous ? job.shots.findIndex(result => result.original === shot.original) : -1;
                    const renamedIndex = existingIndex < 0 && previous ? job.shots.findIndex(result => result.shot.id === shot.shot.id && !job.confirmed.has(result)) : -1;
                    const index = existingIndex >= 0 ? existingIndex : renamedIndex;
                    if (index >= 0) job.shots[index] = shot;
                    else job.shots.push(shot);
                    job.confirmed.add(shot);
                    this.queueThumbnail(job, shot);
                    job.status.clipCount = discovered.length;
                    this.publishProgress();
                }, (message) => {
                    if (job.status.warnings.length < 100) job.status.warnings.push(message);
                });
                await this.organization.flushScans();
                const currentRoot = await stat(source.path);
                if (`${currentRoot.dev}:${currentRoot.ino}:${currentRoot.birthtimeMs}` !== job.rootIdentity) {
                    if (!previous) {
                        job.shots = [];
                        job.status.clipCount = 0;
                    }
                    throw new Error("Source replaced during scan");
                }
                job.controller.signal.throwIfAborted();
                if (previous) {
                    if (job.status.warnings.length) throw new Error("Refresh was incomplete");
                    job.shots = discovered;
                }
                job.controller.signal.throwIfAborted();
                job.status.state = "complete";
                this.publish();
            } catch {
                if (!job.controller.signal.aborted) {
                    job.status.state = "failed";
                    job.status.clipCount = job.shots.length;
                    job.status.error = previous
                        ? "Refresh incomplete. Previously discovered clips have been retained."
                        : "Scan interrupted. Some clips may not have been discovered.";
                    this.publish();
                }
            }
        });
    }

    isBusy(id: string): boolean {
        const state = this.jobs.get(id)?.status.state;
        return state === "queued" || state === "scanning";
    }

    async updateOrganization(ids: string[], action: OrganizationAction) {
        const targets = [...new Set(ids)].map(id => this.findShot(id));
        const valid = () => targets.every(({ job, result }) => this.jobs.get(job.source.id) === job &&
            !this.isReconciling(job, result) && job.shots.includes(result) && !!result.shot.fingerprint && !!result.shot.organization);
        if (!valid()) throw Object.assign(new Error("Selected clips are locked or their drafts are unavailable."), { statusCode: 409 });
        const changed = await this.organization.update(targets.map(({ result }) => result.shot.fingerprint!), action, valid);
        for (const job of this.jobs.values()) for (const { shot } of job.shots) {
            if (shot.fingerprint) {
                const data = changed.drafts[organizationKey(shot.fingerprint)];
                if (data) shot.organization = structuredClone(data);
            }
        }
        this.publish();
        return { collection: this.snapshot(), vocabulary: await this.vocabulary() };
    }

    private optionsEditable = () => ![...this.jobs.keys()].some(id => this.isBusy(id)) && !this.clearingCache;

    private activeDraftKeys() {
        return new Set([...this.jobs.values()].flatMap(job => job.shots.flatMap(({ shot }) =>
            shot.fingerprint ? [organizationKey(shot.fingerprint)] : [])));
    }

    previewOptions(removals: TagVocabulary) {
        if (!this.optionsEditable()) throw Object.assign(new Error("Wait for scanning to finish, then save again."), { statusCode: 409 });
        return this.organization.previewOptions(removals, this.activeDraftKeys());
    }

    async removeOptions(removals: TagVocabulary, reviewToken: string) {
        if (!this.optionsEditable()) throw Object.assign(new Error("Wait for scanning to finish, then save again."), { statusCode: 409 });
        const changed = await this.organization.removeOptions(removals, reviewToken, this.optionsEditable, this.activeDraftKeys());
        for (const job of this.jobs.values()) for (const { shot } of job.shots) {
            if (shot.fingerprint) {
                const data = changed.drafts[organizationKey(shot.fingerprint)];
                if (data) shot.organization = structuredClone(data);
            }
        }
        this.publish();
        return { vocabulary: await this.vocabulary(), collection: this.snapshot() };
    }

    private isReconciling(job: ScanJob, result: DiscoveredShot): boolean {
        return job.refreshing && this.isBusy(job.source.id) && !job.confirmed.has(result);
    }

    remove(id: string, publish = true) {
        const job = this.jobs.get(id);
        job?.controller.abort();
        if (this.jobs.delete(id) && publish) this.publish();
    }

    snapshot(): ShotCollection {
        return {
            revision: this.revision,
            shots: [...this.jobs.values()].flatMap((job) => job.shots.map((result) => ({
                ...result.shot,
                available: job.source.available,
                editable: !this.isReconciling(job, result),
            }))).sort((first, second) =>
                first.timestamp.slice(0, 10).localeCompare(second.timestamp.slice(0, 10)) ||
                Date.parse(first.timestamp) - Date.parse(second.timestamp) || first.id.localeCompare(second.id)),
            scans: [...this.jobs.values()].map((job) => ({ ...job.status, warnings: [...job.status.warnings] })),
        };
    }

    private findShot(id: string) {
        const matches = [...this.jobs.values()].flatMap(job => job.shots
            .filter(item => item.shot.id === id).map(result => ({ job, result })));
        matches.sort((a, b) => Number(b.job.source.available) - Number(a.job.source.available) ||
            Number(this.isReconciling(a.job, a.result)) - Number(this.isReconciling(b.job, b.result)));
        if (matches[0]) return matches[0];
        throw Object.assign(new Error("Clip is no longer available."), { statusCode: 404 });
    }

    private async videoPath(id: string) {
        const { job, result } = this.findShot(id);
        if (!job.source.available) throw Object.assign(new Error("Source is unavailable."), { statusCode: 409 });
        const asset = result.original;
        try {
            const root = await stat(job.source.path);
            if (`${root.dev}:${root.ino}:${root.birthtimeMs}` !== job.rootIdentity) throw new Error("Source changed");
            const path = await realpath(asset);
            const withinRoot = relative(job.source.path, path);
            if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) throw new Error("Asset outside source");
            const info = await stat(path);
            if ([info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs].join(":") !== result.fileIdentity) {
                throw new Error("Video changed; rescan before accessing it.");
            }
            return { path, job, result };
        } catch {
            throw Object.assign(new Error("Source or file is no longer accessible."), { statusCode: 410 });
        }
    }

    async openVideo(id: string) {
        const asset = await this.videoPath(id);
        let file: FileHandle | undefined;
        try {
            file = await open(asset.path, "r");
            const info = await file.stat();
            if (!info.isFile() || [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs].join(":") !== asset.result.fileIdentity ||
                this.jobs.get(asset.job.source.id) !== asset.job || !asset.job.source.available) {
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
        const { job, result } = this.findShot(id);
        const details: ShotDetails = {
            file: { filename: result.shot.filename, path: result.original, bytes: result.shot.bytes },
            metadata: result.shot.metadata, fingerprint: result.shot.fingerprint, embeddedMetadata: result.embeddedMetadata,
            mediaInfo: result.mediaInfo ?? null, errors: [],
        };
        if (!job.source.available) return details;
        try {
            const asset = await this.videoPath(id);
            details.file.bytes = (await stat(asset.path)).size;
            details.file.path = asset.path;
        } catch { details.errors.push("The video file could not be read."); }
        return details;
    }

    private thumbnailCurrent(job: ScanJob, result: DiscoveredShot, revision: number | undefined) {
        return !this.clearingCache && this.jobs.get(job.source.id) === job && job.source.available &&
            !job.controller.signal.aborted && job.shots.includes(result) && !this.isReconciling(job, result) &&
            result.shot.thumbnailRevision === revision;
    }

    private async thumbnailSourceValid(job: ScanJob, result: DiscoveredShot, revision: number | undefined) {
        if (!this.thumbnailCurrent(job, result, revision)) return false;
        try {
            const root = await stat(job.source.path);
            if (`${root.dev}:${root.ino}:${root.birthtimeMs}` !== job.rootIdentity) return false;
            const path = await realpath(result.original);
            const withinRoot = relative(job.source.path, path);
            if (withinRoot.startsWith('..') || isAbsolute(withinRoot)) return false;
            const info = await stat(path);
            return info.isFile() && [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs].join(':') === result.fileIdentity &&
                this.thumbnailCurrent(job, result, revision);
        } catch { return false; }
    }

    // Generation belongs to discovery, independently of which cards the renderer has displayed.
    private queueThumbnail(job: ScanJob, result: DiscoveredShot) {
        const revision = result.shot.thumbnailRevision;
        if (!this.thumbnailQueue || !this.thumbnailCurrent(job, result, revision) || result.shot.thumbnailStatus) return;
        result.shot.thumbnailStatus = 'pending';
        const valid = () => this.thumbnailSourceValid(job, result, revision);
        this.thumbnailQueue.enqueue([result.original], job.rootIdentity ?? '', job.controller.signal, valid, image => {
            if (this.jobs.get(job.source.id) !== job || !job.shots.includes(result) || result.shot.thumbnailRevision !== revision) return;
            if (!job.source.available) result.shot.thumbnailStatus = undefined;
            else {
                result.shot.thumbnailStatus = image ? 'ready' : 'failed';
                result.shot.hasThumbnail = !!image;
            }
            // Images remain in the disk cache; scanning does not retain every data URL in memory.
            this.publishProgress();
        }, result.shot.metadata);
    }

    async thumbnail(id: string): Promise<string | null> {
        if (!this.thumbnailQueue || this.clearingCache) return null;
        for (const job of this.jobs.values()) for (const result of job.shots) {
            if (result.shot.id !== id) continue;
            const revision = result.shot.thumbnailRevision;
            if (!await this.thumbnailSourceValid(job, result, revision)) continue;
            const image = await this.thumbnailQueue.image(result.original, job.rootIdentity ?? '', result.shot.metadata);
            if (image && await this.thumbnailSourceValid(job, result, revision)) return image;
        }
        return null;
    }

    async setThumbnail(id: string, dataUrl: string) {
        if (this.clearingCache) throw Object.assign(new Error("Cache clearing is in progress."), { statusCode: 409 });
        if (this.updatingThumbnails.has(id)) throw Object.assign(new Error("Thumbnail update is already in progress."), { statusCode: 409 });
        this.updatingThumbnails.add(id);
        try {
            const asset = await this.videoPath(id);
            if (this.isReconciling(asset.job, asset.result)) throw Object.assign(new Error("Wait for rescanning to finish."), { statusCode: 409 });
            if (!this.thumbnailQueue) throw new Error("Thumbnail cache is unavailable.");
            const valid = async () => {
                try {
                    const current = await this.videoPath(id);
                    return current.job === asset.job && current.path === asset.path && !this.isReconciling(asset.job, asset.result);
                } catch { return false; }
            };
            await this.thumbnailQueue.setCustomImage(asset.path, asset.job.rootIdentity ?? "", dataUrl, valid, asset.result.shot.metadata);
            if (!await valid()) throw new Error("Source changed while updating the thumbnail.");
            asset.result.shot.hasCustomThumbnail = true;
            asset.result.shot.hasThumbnail = true;
            asset.result.shot.thumbnailStatus = "ready";
            asset.result.shot.thumbnailRevision = (asset.result.shot.thumbnailRevision ?? 0) + 1;
            this.publish();
        } finally { this.updatingThumbnails.delete(id); }
    }

    async close() {
        this.onChange = undefined;
        clearTimeout(this.progressTimer);
        for (const id of this.jobs.keys()) this.remove(id);
        await this.thumbnailQueue?.close();
        await this.pending;
        await this.organization.flushScans().catch(error => console.warn('Scan bookkeeping could not be saved; existing drafts preserved.', error));
        await this.organization.prune().catch(error => console.warn('Draft retention cleanup failed; saved drafts preserved.', error));
    }
}
