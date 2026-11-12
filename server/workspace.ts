import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { isVideoPath } from "./discovery";
import type { DiscoveryRequest } from "../shared/shots";
import { ShotScanner } from "./scanner";
import type { TagVocabulary } from "../shared/organization";

// Folder requests are temporary discovery work, never owners of workspace clips.
export class WorkspaceManager {
    readonly scanner: ShotScanner;
    private monitor?: ReturnType<typeof setTimeout>;
    private availabilityCheck?: Promise<void>;
    private closed = false;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(thumbnailCacheDirectory?: string, fingerprintDirectory?: string, organizationFile?: string, assertWritable?: () => Promise<void>) {
        this.scanner = new ShotScanner(thumbnailCacheDirectory, fingerprintDirectory, organizationFile, assertWritable);
    }

    private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => undefined);
        return result;
    }

    add(selectedPath: string): Promise<DiscoveryRequest> {
        return this.serialize(async () => {
            if (this.closed) throw new Error("The workspace is closing.");
            const path = await realpath(selectedPath);
            const info = await stat(path);
            if (!info.isDirectory() && !(info.isFile() && isVideoPath(path)))
                throw Object.assign(new Error("Choose a folder or a supported video file."), { statusCode: 400 });
            const request = { id: randomUUID(), path: info.isDirectory() ? path : dirname(path) };
            this.scanner.discover(request, info.isFile() ? [path] : undefined);
            return request;
        });
    }

    startMonitoring(intervalMs = 5000) {
        if (this.monitor || this.closed) return;
        const tick = async () => {
            try { await this.checkAvailability(); }
            catch (error) { console.warn('Workspace availability check failed.', error); }
            if (!this.closed) this.monitor = setTimeout(tick, intervalMs);
            this.monitor?.unref();
        };
        this.monitor = setTimeout(tick, intervalMs);
        this.monitor.unref();
    }

    checkAvailability(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.availabilityCheck) return this.availabilityCheck;
        this.availabilityCheck = this.scanner.checkDirectories().finally(() => { this.availabilityCheck = undefined; });
        return this.availabilityCheck;
    }

    async close() {
        this.closed = true;
        clearTimeout(this.monitor);
        await this.pending;
        await this.availabilityCheck;
        await this.scanner.close();
    }

    localDataSummary() { return this.scanner.localDataSummary(); }

    clearLocalData() {
        return this.serialize(async () => {
            await this.scanner.clearLocalData();
            return { summary: await this.localDataSummary(), collection: this.scanner.snapshot() };
        });
    }

    previewOptions(removals: TagVocabulary) {
        return this.serialize(() => this.scanner.previewOptions(removals));
    }

    saveOptions(removals: TagVocabulary, reviewToken: string) {
        return this.serialize(() => this.scanner.removeOptions(removals, reviewToken));
    }
}
