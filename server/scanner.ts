import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ImportSource } from "../shared/desktop";
import type { ShotCollection, SourceScan } from "../shared/shots";
import { discoverShots, readSmallFile } from "./discovery";
import type { DiscoveredShot } from "./discovery";

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
        this.jobs.get(id)?.controller.abort();
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

    async thumbnail(id: string): Promise<string | null> {
        for (const job of this.jobs.values()) {
            if (!job.source.available) continue;
            const result = job.shots.find((item) => item.shot.id === id);
            if (!result?.assets.thumbnail) continue;
            try {
                const info = await stat(job.source.path);
                if (`${info.dev}:${info.ino}:${info.birthtimeMs}` !== job.rootIdentity) return null;
                const path = await realpath(result.assets.thumbnail);
                const withinRoot = relative(job.source.path, path);
                if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) return null;
                const bytes = await readSmallFile(path, 2 * 1024 * 1024);
                if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
                if (this.jobs.get(job.source.id) !== job || !job.source.available || job.controller.signal.aborted) return null;
                return `data:image/jpeg;base64,${bytes.toString("base64")}`;
            } catch { return null; }
        }
        return null;
    }

    async close() {
        this.onChange = undefined;
        clearTimeout(this.progressTimer);
        for (const id of this.jobs.keys()) this.remove(id);
        await this.pending;
    }
}
