import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ImportSource } from "../shared/desktop";
import type { ShotCollection, ShotDetails, SourceScan } from "../shared/shots";
import { discoverShots } from "./discovery";
import type { DiscoveredShot } from "./discovery";
import { ThumbnailQueue } from "./thumbnails";
import { commonFingerprintMetadata, VideoFingerprintStore } from "./fingerprints";
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
    onChange?: (collection: ShotCollection) => void;
    private thumbnailQueue?: ThumbnailQueue;
    private fingerprints: VideoFingerprintStore;
    readonly organization: OrganizationStore;
    private generatedImages = new Map<string, string>();
    private updatingThumbnails = new Set<string>();
    private clearingCache = false;

    async cacheSummary() {
        return this.thumbnailQueue?.cacheSummary() ?? { bytes: 0, files: 0 };
    }

    async vocabulary(): Promise<TagVocabulary> {
        const options = await this.organization.vocabulary();
        // Only loaded clips contribute suggestions, including temporarily unavailable sources.
        options.context = [...new Set([...this.jobs.values()].flatMap(job =>
            job.shots.flatMap(({ shot }) => shot.organization?.context ?? [])))].sort();
        return options;
    }

    async localDataSummary() {
        const cache = await this.cacheSummary();
        const lists = await this.vocabulary();
        return { ...cache, options: lists.identity.length + lists.projects.length + lists.context.length,
            identities: lists.identity.length, projects: lists.projects.length, tags: lists.context.length,
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
            this.generatedImages.clear();
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
            this.generatedImages.clear();
            for (const job of this.jobs.values()) for (const { shot } of job.shots) {
                shot.hasThumbnail = false;
                shot.hasCustomThumbnail = false;
                shot.thumbnailStatus = undefined;
                shot.thumbnailRevision = (shot.thumbnailRevision ?? 0) + 1;
            }
            this.clearingCache = false;
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
        this.onChange?.(this.snapshot());
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
                if (availabilityChanged) this.publish();
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
                    const streams = shot.mediaInfo?.streams as { codec_type?: string; nb_frames?: string }[] | undefined;
                    shot.fingerprintMetadata = commonFingerprintMetadata(shot.shot.metadata, {
                        recordingDate: shot.shot.dateSource === "file-modified" ? null : shot.shot.timestamp,
                        durationSeconds: shot.shot.durationSeconds,
                        frameCount: Array.isArray(streams) ? streams.find((stream) => stream.codec_type === "video")?.nb_frames : null,
                    });
                    try {
                        shot.shot.fingerprint = await this.fingerprints.identify(shot.original, shot.fingerprintMetadata, job.controller.signal);
                        const current = await stat(shot.original);
                        if ([current.dev, current.ino, current.birthtimeMs, current.size, current.mtimeMs].join(":") !== shot.fileIdentity) {
                            throw new Error("Video changed after metadata discovery.");
                        }
                    } catch {
                        job.controller.signal.throwIfAborted();
                        job.status.warnings.push(`Could not fingerprint ${shot.shot.filename}. File was skipped; refresh this source to retry.`);
                        return;
                    }
                    shot.shot.id = shot.shot.fingerprint.value;
                    try {
                        shot.shot.organization = await this.organization.scanned(shot.shot.fingerprint, job.controller.signal, { name: shot.shot.filename, path: shot.original });
                    } catch {
                        job.controller.signal.throwIfAborted();
                        job.status.warnings.push(`Could not load attributes for ${shot.shot.filename}. File was skipped; refresh this source to retry.`);
                        return;
                    }
                    // Preview failures must not prevent a fully identified clip from appearing.
                    try { await this.thumbnailQueue?.touch(shot.original, job.rootIdentity ?? "", shot.shot.metadata, shot.fingerprintMetadata); }
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
                    job.status.clipCount = discovered.length;
                    this.publishProgress();
                }, (message) => {
                    if (job.status.warnings.length < 100) job.status.warnings.push(message);
                });
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
        for (const result of job?.shots ?? []) {
            this.generatedImages.delete(result.shot.id);
        }
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

    async thumbnail(id: string): Promise<string | null> {
        if (this.clearingCache) return null;
        for (const job of this.jobs.values()) {
            if (!job.source.available) continue;
            const result = job.shots.find((item) => item.shot.id === id);
            if (!result) continue;
            try {
                const valid = async () => {
                    if (this.clearingCache) return false;
                    if (this.jobs.get(job.source.id) !== job || !job.source.available || job.controller.signal.aborted) return false;
                    try {
                        const info = await stat(job.source.path);
                        return `${info.dev}:${info.ino}:${info.birthtimeMs}` === job.rootIdentity;
                    } catch { return false; }
                };
                if (!await valid()) return null;
                const resolveAsset = async (asset: string) => {
                    const path = await realpath(asset);
                    const withinRoot = relative(job.source.path, path);
                    return !withinRoot.startsWith("..") && !isAbsolute(withinRoot) ? path : null;
                };
                const original = await resolveAsset(result.original);
                const generated = this.generatedImages.get(id);
                if (generated) return generated;
                if (!this.thumbnailQueue) return null;
                const inputs = original ? [original] : [];
                if (!await valid()) return null;
                if (!inputs.length) return null;
                if (result.shot.thumbnailStatus === "pending" || result.shot.thumbnailStatus === "failed") return null;
                result.shot.thumbnailStatus = "pending";
                const thumbnailRevision = result.shot.thumbnailRevision;
                this.publishProgress();
                this.thumbnailQueue.enqueue(inputs, job.rootIdentity ?? "", job.controller.signal, valid, (image) => {
                    if (this.jobs.get(job.source.id) !== job || result.shot.thumbnailRevision !== thumbnailRevision) return;
                    if (!job.source.available) {
                        result.shot.thumbnailStatus = undefined;
                        this.publishProgress();
                        return;
                    }
                    result.shot.thumbnailStatus = image ? "ready" : "failed";
                    if (image) {
                        this.generatedImages.set(id, image);
                        result.shot.hasThumbnail = true;
                    }
                    this.publishProgress();
                }, result.shot.metadata, result.fingerprintMetadata);
                return null;
            } catch { return null; }
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
            await this.thumbnailQueue.setCustomImage(asset.path, asset.job.rootIdentity ?? "", dataUrl, valid, asset.result.shot.metadata, asset.result.fingerprintMetadata);
            if (!await valid()) throw new Error("Source changed while updating the thumbnail.");
            this.generatedImages.delete(id);
            asset.result.shot.hasCustomThumbnail = true;
            asset.result.shot.hasThumbnail = true;
            asset.result.shot.thumbnailStatus = undefined;
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
        await this.organization.prune().catch(error => console.warn('Draft retention cleanup failed; saved drafts preserved.', error));
    }
}
