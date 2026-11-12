import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ImportSource } from "../shared/desktop";
import type { IngestionReceipt, IngestState, ProxyState } from "../shared/ingestion";
import { ingestAttributes } from "../shared/ingestion";
import type { ClipAttributes, OrganizationAction, TagVocabulary } from "../shared/organization";
import { organizationKey } from "../shared/organization";
import type { ShotChange, ShotCollection, ShotDetails, SourceScan, VideoShot } from "../shared/shots";
import type { WorkspaceRestore } from "../shared/shots";
import type { DiscoveredShot } from "./discovery";
import { discoverShots } from "./discovery";
import { VideoFingerprintStore } from "./fingerprints";
import type { LibraryPresence } from "./library";
import { OrganizationStore } from "./organization";
import { ThumbnailQueue } from "./thumbnails";

interface ScanJob {
    source: ImportSource;
    status: SourceScan;
    controller: AbortController;
    token: number;
    rootIdentity?: string;
    files?: string[];
    refreshing: boolean;
    before: Set<string>;
    confirmed: Set<string>;
}

// Workspace membership and file access outlive the scan that discovered a clip.
interface WorkspaceClip {
    result: DiscoveredShot;
    controller: AbortController;
    previewIdentity: string;
    reconciling?: number;
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
            const { clip, result } = this.findShot(id);
            if (this.ingestLocks.has(id) || this.ejecting.has(id) || !result.shot.available || this.isReconciling(clip))
                throw new Error("Clips are unavailable or already queued.");
        }
        ids.forEach((id) => this.ingestLocks.set(id, "queued"));
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
            this.isReconciling(asset.clip) ||
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

    sourceRoots() {
        return [...new Set([
            ...[...this.clips.values()].map(({ result }) => dirname(result.original)),
            ...[...this.jobs.values()].filter(job => this.isBusy(job.source.id)).map(job => job.source.path),
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

    // Compatibility adapter for the current Source controls. Scans themselves never own clips.
    sync(sources: ImportSource[]) {
        const registered = new Set(sources.map(source => source.id));
        const oldIds = new Set([...this.jobs.keys(), ...[...this.clips.values()].map(clip => clip.result.shot.sourceId)]);
        for (const id of oldIds) if (!registered.has(id)) this.remove(id);
        for (const source of sources) {
            const job = this.jobs.get(source.id);
            if (job) {
                job.source = source;
                if (!source.available && this.isBusy(source.id)) {
                    job.status.state = "interrupted";
                    job.status.error = "Scan interrupted because the folder became unavailable. Discovered clips have been retained.";
                    job.controller.abort();
                    this.finishScan(job);
                    this.publish();
                }
            } else if (source.available) this.schedule(source);
        }
    }

    schedule(source: ImportSource) {
        if (this.jobs.has(source.id)) return;
        this.enqueue(source, false);
    }

    discover(source: ImportSource) { this.enqueue(source, false); }

    refresh(source: ImportSource) { this.enqueue(source, true); }

    private finishScan(job: ScanJob) {
        for (const clip of this.clips.values()) if (clip.reconciling === job.token) {
            clip.reconciling = undefined;
            this.queueThumbnail(clip);
        }
        job.before.clear(); job.confirmed.clear();
    }

    // Cancelling/discarding discovery does not eject the clips it already published.
    cancelScan(id: string, publish = true) {
        const job = this.jobs.get(id);
        if (!job) return;
        job.controller.abort();
        this.jobs.delete(id);
        this.finishScan(job);
        if (publish) this.publish();
    }

    restoreFiles(paths: string[]) {
        const groups = new Map<string, string[]>();
        for (const path of new Set(paths)) {
            const directory = dirname(path);
            const files = groups.get(directory) ?? []; files.push(path); groups.set(directory, files);
        }
        for (const [path, files] of groups) this.enqueue({ id: randomUUID(), path, name: path, type: "folder", available: true, cameraModels: [] }, false, files);
    }

    restorePlan(): WorkspaceRestore {
        const active = [...this.jobs.values()].filter(job => this.isBusy(job.source.id));
        return {
            files: [...this.clips.values()].filter(clip => clip.result.shot.available).map(clip => clip.result.original),
            scans: active.map(job => ({ path: job.source.path, files: job.files })),
            excludedIds: active.some(job => !job.files) ? [...this.ejectedAt.keys()].filter(id => !this.clips.has(id)) : [],
        };
    }

    restoreWorkspace(plan: WorkspaceRestore) {
        this.restoreFiles(plan.files);
        for (const scan of plan.scans) this.enqueue({ id: randomUUID(), path: scan.path, name: scan.path, type: "folder", available: true, cameraModels: [] }, false, scan.files);
        for (const id of plan.excludedIds) this.ejectedAt.set(id, this.scanToken);
    }

    private enqueue(source: ImportSource, refreshing: boolean, files?: string[]) {
        if (this.closed) return;
        this.cancelScan(source.id, false);
        const job: ScanJob = {
            source, files, status: { sourceId: source.id, path: source.path, state: "queued", clipCount: 0, warnings: [] },
            controller: new AbortController(), token: ++this.scanToken, refreshing,
            before: new Set([...this.clips].filter(([, clip]) => clip.result.shot.sourceId === source.id).map(([id]) => id)),
            confirmed: new Set(),
        };
        if (refreshing) for (const id of job.before) {
            const clip = this.clips.get(id)!;
            if (this.ingestLocks.has(id)) continue;
            clip.controller.abort(); clip.controller = new AbortController();
            clip.reconciling = job.token;
            if (clip.result.shot.thumbnailStatus === "pending" || clip.result.shot.thumbnailStatus === "failed") clip.result.shot.thumbnailStatus = undefined;
        }
        this.jobs.set(source.id, job);
        this.publish();
        this.pending = this.pending.catch(() => undefined).then(async () => {
            if (job.controller.signal.aborted) return;
            job.status.state = "scanning"; this.publish();
            try {
                const root = await stat(source.path);
                job.rootIdentity = `${root.dev}:${root.ino}:${root.birthtimeMs}`;
                await discoverShots(source, job.controller.signal, async result => {
                    try {
                        result.shot.fingerprint = await this.fingerprints.identify(result.original, job.controller.signal);
                        if (!await this.fileMatches(result)) throw new Error("Video changed after metadata discovery.");
                    } catch (error) {
                        job.controller.signal.throwIfAborted();
                        if (job.status.warnings.length < 100) job.status.warnings.push(`Could not fingerprint ${result.shot.filename}. ${error instanceof Error ? error.message : "Fingerprint unavailable."} File was skipped; refresh this source to retry.`);
                        return;
                    }
                    result.shot.id = result.shot.fingerprint.value;
                    try {
                        result.shot.organization = await this.organization.scanned(result.shot.fingerprint, job.controller.signal, { name: result.shot.filename, path: result.original });
                        result.shot.ingestion = await this.organization.ingestion(result.shot.fingerprint);
                    } catch {
                        job.controller.signal.throwIfAborted();
                        if (job.status.warnings.length < 100) job.status.warnings.push(`Could not load attributes for ${result.shot.filename}. Saved data has been preserved. File was skipped; refresh this source to retry.`);
                        return;
                    }
                    try { await this.thumbnailQueue?.touch(result.original, job.rootIdentity ?? "", result.shot.metadata); }
                    catch { job.controller.signal.throwIfAborted(); }
                    job.controller.signal.throwIfAborted();
                    if (this.jobs.get(source.id) !== job) return;
                    await this.admitClip(result, job);
                    const active = this.clips.get(result.shot.id);
                    if (active && active.result.original !== result.original) {
                        await this.organization.scanned(result.shot.fingerprint!, job.controller.signal, {
                            name: active.result.shot.filename, path: active.result.original,
                        });
                    }
                    job.controller.signal.throwIfAborted();
                    job.confirmed.add(result.shot.id);
                    job.status.clipCount++;
                    this.publishProgress();
                }, message => { if (job.status.warnings.length < 100) job.status.warnings.push(message); }, job.files);
                await this.organization.flushScans();
                const currentRoot = await stat(source.path);
                if (`${currentRoot.dev}:${currentRoot.ino}:${currentRoot.birthtimeMs}` !== job.rootIdentity) throw new Error("Folder replaced during scan");
                job.controller.signal.throwIfAborted();
                if (refreshing) {
                    if (job.status.warnings.length) throw new Error("Refresh was incomplete");
                    // Explicit legacy rescan reconciles only its previous active locations.
                    for (const id of job.before) if (!job.confirmed.has(id) && !this.ingestLocks.has(id)) this.dropClip(id);
                }
                job.status.state = "complete";
            } catch {
                if (!job.controller.signal.aborted) {
                    job.status.state = "failed";
                    job.status.error = refreshing ? "Refresh incomplete. Previously discovered clips have been retained." : "Scan interrupted. Some clips may not have been discovered.";
                }
            } finally {
                this.finishScan(job);
                if (this.jobs.get(source.id) === job) this.publish();
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
        if (this.jobs.get(job.source.id) !== job || this.ejecting.has(id) || (this.ejectedAt.get(id) ?? -1) >= job.token) return;
        if (current && keep) {
            // Rediscovery is idempotent; edits and the chosen path stay on the workspace record.
            if (!this.ingestLocks.has(id)) this.setAvailable(current, true);
            if (current.reconciling === job.token) current.reconciling = undefined;
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
                    !this.isReconciling(clip) &&
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

    async revertOrganization(ids: string[], read: () => Promise<ClipAttributes[]>) {
        const targets = [...new Set(ids)].map((id) => {
            const asset = this.findShot(id);
            return { ...asset, organization: JSON.stringify(asset.result.shot.organization) };
        });
        const valid = () =>
            !this.clearingCache &&
            targets.every(
                ({ clip, result, organization }) =>
                    this.clips.get(result.shot.id) === clip &&
                    !this.ingestLocks.has(result.shot.id) && !this.ejecting.has(result.shot.id) &&
                    !this.isReconciling(clip) &&
                    !!result.shot.fingerprint &&
                    !!result.shot.organization &&
                    JSON.stringify(result.shot.organization) === organization,
            );
        if (!targets.length || !valid())
            throw new Error("Selected clips are locked or their attributes are unavailable.");
        const attributes = await read();
        if (attributes.length !== targets.length) throw new Error("Library attributes are incomplete.");
        const changed = await this.organization.restore(
            targets.map(({ result }, index) => ({
                fingerprint: result.shot.fingerprint!,
                attributes: attributes[index],
            })),
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

    private isReconciling(clip: WorkspaceClip) { return clip.reconciling !== undefined; }

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

    // The existing Remove Source action explicitly removes its workspace members.
    // Unlike cancelScan, this is a membership operation, retained until Eject replaces it.
    remove(id: string, publish = true) {
        this.cancelScan(id, false);
        for (const [clipId, clip] of this.clips) if (clip.result.shot.sourceId === id && !this.ingestLocks.has(clipId)) this.dropClip(clipId);
        if (publish) this.publish();
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
                editable: !this.isReconciling(clip) && !this.ingestLocks.has(clip.result.shot.id) && !this.ejecting.has(clip.result.shot.id) &&
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
            return info.isFile() && [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs].join(":") === result.fileIdentity;
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
                [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs].join(":") !==
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
            !clip.controller.signal.aborted && !this.ejecting.has(clip.result.shot.id) && !this.isReconciling(clip) && clip.result.shot.thumbnailRevision === revision;
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
        if (this.clearingCache) throw Object.assign(new Error("Cache clearing is in progress."), { statusCode: 409 });
        if (this.updatingThumbnails.has(id))
            throw Object.assign(new Error("Thumbnail update is already in progress."), { statusCode: 409 });
        this.updatingThumbnails.add(id);
        try {
            if (this.ingestLocks.has(id) || this.ejecting.has(id)) throw new Error("Clip is queued for a Library commit or being ejected.");
            const asset = await this.videoPath(id);
            if (this.isReconciling(asset.clip))
                throw Object.assign(new Error("Wait for rescanning to finish."), { statusCode: 409 });
            if (!this.thumbnailQueue) throw new Error("Thumbnail cache is unavailable.");
            const valid = async () => {
                try {
                    const current = await this.videoPath(id);
                    return (
                        !this.ingestLocks.has(id) && !this.ejecting.has(id) &&
                        current.clip === asset.clip &&
                        current.path === asset.path &&
                        !this.isReconciling(asset.clip)
                    );
                } catch {
                    return false;
                }
            };
            await this.thumbnailQueue.setCustomImage(
                asset.path,
                asset.clip.previewIdentity,
                dataUrl,
                valid,
                asset.result.shot.metadata,
            );
            if (!(await valid())) throw new Error("Source changed while updating the thumbnail.");
            asset.result.shot.thumbnailDigest = createHash("sha256")
                .update(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"))
                .digest("hex");
            asset.result.shot.hasCustomThumbnail = true;
            asset.result.shot.hasThumbnail = true;
            asset.result.shot.thumbnailStatus = "ready";
            asset.result.shot.thumbnailRevision = (asset.result.shot.thumbnailRevision ?? 0) + 1;
            this.publish();
        } finally {
            this.updatingThumbnails.delete(id);
        }
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

export function ingestionSignature(
    attributes: import("../shared/organization").ClipAttributes,
    thumbnailDigest: string,
) {
    return createHash("sha256")
        .update(JSON.stringify([ingestAttributes(attributes), thumbnailDigest]))
        .digest("hex");
}
