import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import type { ImportSource } from "../shared/desktop";
import type { ShotCollection, ShotDetails, SourceScan } from "../shared/shots";
import { discoverShots, readSmallFile } from "./discovery";
import type { DiscoveredShot } from "./discovery";
import { isJpeg, ThumbnailQueue } from "./thumbnails";

interface ScanJob {
    source: ImportSource;
    status: SourceScan;
    controller: AbortController;
    shots: DiscoveredShot[];
    rootIdentity?: string;
}

export class ShotScanner {
    private jobs = new Map<string, ScanJob>();
    private pending: Promise<void> = Promise.resolve();
    private revision = 0;
    private progressTimer?: ReturnType<typeof setTimeout>;
    onChange?: (collection: ShotCollection) => void;
    private thumbnailQueue?: ThumbnailQueue;
    private generatedImages = new Map<string, string>();

    constructor(thumbnailCacheDirectory?: string) {
        if (thumbnailCacheDirectory) this.thumbnailQueue = new ThumbnailQueue(thumbnailCacheDirectory);
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
            shots: previous?.shots ?? [],
            rootIdentity: previous?.rootIdentity,
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
                await discoverShots(source, job.controller.signal, (shot) => {
                    discovered.push(shot);
                    if (!previous) job.shots.push(shot);
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
                    const existing = new Map(previous.shots.map((result) => [result.shot.id, result]));
                    job.shots = discovered.map((result) => existing.get(result.shot.id) ?? result);
                }
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

    remove(id: string, publish = true) {
        const job = this.jobs.get(id);
        job?.controller.abort();
        for (const result of job?.shots ?? []) this.generatedImages.delete(result.shot.id);
        if (this.jobs.delete(id) && publish) this.publish();
    }

    snapshot(): ShotCollection {
        return {
            revision: this.revision,
            shots: [...this.jobs.values()].flatMap((job) => job.shots.map((result) => ({
                ...result.shot,
                available: job.source.available,
                editable: job.source.available && !this.isBusy(job.source.id),
            }))).sort((first, second) =>
                first.timestamp.slice(0, 10).localeCompare(second.timestamp.slice(0, 10)) ||
                Date.parse(first.timestamp) - Date.parse(second.timestamp) || first.id.localeCompare(second.id)),
            scans: [...this.jobs.values()].map((job) => ({ ...job.status, warnings: [...job.status.warnings] })),
        };
    }

    private findShot(id: string) {
        for (const job of this.jobs.values()) {
            const result = job.shots.find((item) => item.shot.id === id);
            if (result) return { job, result };
        }
        throw Object.assign(new Error("Clip is no longer available."), { statusCode: 404 });
    }

    private async assetPath(id: string, role: keyof DiscoveredShot["assets"]) {
        const { job, result } = this.findShot(id);
        if (!job.source.available) throw Object.assign(new Error("Source is unavailable."), { statusCode: 409 });
        const asset = result.assets[role];
        if (!asset) throw Object.assign(new Error("Requested asset is not available."), { statusCode: 404 });
        try {
            const root = await stat(job.source.path);
            if (`${root.dev}:${root.ino}:${root.birthtimeMs}` !== job.rootIdentity) throw new Error("Source changed");
            const path = await realpath(asset);
            const withinRoot = relative(job.source.path, path);
            if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) throw new Error("Asset outside source");
            return { path, job, result };
        } catch {
            throw Object.assign(new Error("Source or file is no longer accessible."), { statusCode: 410 });
        }
    }

    async openVideo(id: string, role: "original" | "proxy") {
        const asset = await this.assetPath(id, role);
        let file: FileHandle | undefined;
        try {
            file = await open(asset.path, "r");
            if (!(await file.stat()).isFile() || this.jobs.get(asset.job.source.id) !== asset.job || !asset.job.source.available) {
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
        const { result } = this.findShot(id);
        const details: ShotDetails = { assets: [], mediaInfo: result.mediaInfo ?? null, cameraXml: null, errors: [] };
        for (const role of ["original", "proxy", "xml"] as const) {
            if (!result.assets[role]) continue;
            try {
                const asset = await this.assetPath(id, role);
                const info = await stat(asset.path);
                details.assets.push({ role, filename: basename(asset.path), path: asset.path, relativePath: relative(asset.job.source.path, asset.path), bytes: info.size });
                if (role === "xml") details.cameraXml = (await readSmallFile(asset.path, 1024 * 1024)).toString("utf8");
            } catch {
                details.errors.push(`The ${role} asset could not be read.`);
            }
        }
        return details;
    }

    async thumbnail(id: string, fallback = false): Promise<string | null> {
        for (const job of this.jobs.values()) {
            if (!job.source.available) continue;
            const result = job.shots.find((item) => item.shot.id === id);
            if (!result) continue;
            try {
                const valid = async () => {
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
                if (!fallback && result.assets.thumbnail) {
                    try {
                        const path = await resolveAsset(result.assets.thumbnail);
                        if (path && this.thumbnailQueue) {
                            const image = await this.thumbnailQueue.cameraImage(path, job.rootIdentity ?? "", job.controller.signal, valid);
                            if (image) return image;
                        }
                        const bytes = path ? await readSmallFile(path, 2 * 1024 * 1024) : null;
                        if (bytes && isJpeg(bytes) && await valid()) return `data:image/jpeg;base64,${bytes.toString("base64")}`;
                    } catch {}
                }
                const generated = this.generatedImages.get(id);
                if (generated) return generated;
                if (!this.thumbnailQueue) return null;
                const inputs: string[] = [];
                for (const asset of [result.assets.proxy, result.assets.original]) {
                    if (!asset) continue;
                    try { const path = await resolveAsset(asset); if (path) inputs.push(path); } catch {}
                }
                if (!await valid()) return null;
                if (!inputs.length) return null;
                if (result.shot.thumbnailStatus === "pending" || result.shot.thumbnailStatus === "failed") return null;
                result.shot.thumbnailStatus = "pending";
                this.publishProgress();
                this.thumbnailQueue.enqueue(inputs, job.rootIdentity ?? "", job.controller.signal, valid, (image) => {
                    if (this.jobs.get(job.source.id) !== job) return;
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
                });
                return null;
            } catch { return null; }
        }
        return null;
    }

    async close() {
        this.onChange = undefined;
        clearTimeout(this.progressTimer);
        for (const id of this.jobs.keys()) this.remove(id);
        await this.thumbnailQueue?.close();
        await this.pending;
    }
}
