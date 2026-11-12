import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ImportSource } from "../shared/desktop";
import { ShotScanner } from "./scanner";
import type { TagVocabulary } from "../shared/organization";


function rootFingerprint(info: { dev: number; ino: number; birthtimeMs: number }) {
    return createHash('sha256').update(`${info.dev}:${info.ino}:${info.birthtimeMs}`).digest('hex');
}

// A selected folder is a discovery request. Camera information comes from each clip.
export async function inspectSource(path: string) {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Choose a directory");
    return { type: "folder" as const, cameraModels: [] as string[], fingerprint: rootFingerprint(info), warning: undefined as string | undefined };
}

export class SourceRegistry {
    readonly scanner: ShotScanner;

    constructor(thumbnailCacheDirectory?: string, fingerprintDirectory?: string, organizationFile?: string, assertWritable?: () => Promise<void>) {
        this.scanner = new ShotScanner(thumbnailCacheDirectory, fingerprintDirectory, organizationFile, assertWritable);
    }
    private sources = new Map<string, { source: ImportSource; fingerprint: string; inspectionWarning?: string }>();
    private monitor?: ReturnType<typeof setTimeout>;
    private availabilityCheck?: Promise<void>;
    private closed = false;
    private pending: Promise<unknown> = Promise.resolve();

    private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => undefined);
        return result;
    }

    add(selectedPath: string): Promise<ImportSource> {
        return this.serialize(async () => {
            const path = await realpath(selectedPath);
            const inspection = await inspectSource(path);
            const existing = this.sources.get(path);
            const source: ImportSource = {
                id: existing?.source.id ?? randomUUID(), name: basename(path) || path, path,
                type: inspection.type, cameraModels: [], available: true,
            };
            // This map only supports legacy diagnostics/endpoints; clips and monitoring do not depend on it.
            this.sources.set(path, { source, fingerprint: inspection.fingerprint });
            this.scanner.discover(source);
            return source;
        });
    }

    list(): ImportSource[] {
        const shots = this.scanner.snapshot().shots;
        return [...this.sources.values()].map(({ source }) => {
            const members = shots.filter(shot => shot.sourceId === source.id);
            return { ...source, available: members.length ? members.some(shot => shot.available) : source.available };
        });
    }

    startMonitoring(intervalMs = 5000) {
        if (this.monitor || this.closed) return;
        const tick = async () => {
            try { await this.checkAvailability(); }
            catch (error) { console.warn('Source availability check failed.', error); }
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
        await this.scanner.close();
    }

    refresh(id: string) {
        return this.serialize(async () => {
            this.scanner.assertNoIngestion();
            const entry = [...this.sources.values()].find((item) => item.source.id === id);
            if (!entry) throw Object.assign(new Error("Source not found."), { statusCode: 404 });
            if (this.scanner.isBusy(id)) {
                throw Object.assign(new Error("Wait for the current scan to finish."), { statusCode: 409 });
            }
            let inspection: Awaited<ReturnType<typeof inspectSource>>;
            try {
                inspection = await inspectSource(entry.source.path);
            } catch {
                entry.source = {
                    ...entry.source,
                    available: false,
                    warning: "Source not found. It may have been disconnected, moved, or renamed. Please resolve to continue.",
                };
                this.scanner.sync([...this.sources.values()].map((item) => item.source));
                throw Object.assign(new Error("Source is unavailable."), { statusCode: 409 });
            }
            this.scanner.assertNoIngestion();
            entry.source = {
                ...entry.source,
                id: entry.fingerprint === inspection.fingerprint ? id : randomUUID(),
                type: inspection.type,
                cameraModels: inspection.cameraModels,
                available: true,
                warning: inspection.warning,
            };
            entry.fingerprint = inspection.fingerprint;
            entry.inspectionWarning = inspection.warning;
            if (entry.source.id === id) this.scanner.refresh(entry.source);
            this.scanner.sync([...this.sources.values()].map((item) => item.source));
            return { source: entry.source, collection: this.scanner.snapshot() };
        });
    }

    relink(id: string, selectedPath: string) {
        return this.serialize(async () => {
            this.scanner.assertNoIngestion();
            const previous = [...this.sources.values()].find((item) => item.source.id === id);
            if (!previous) throw Object.assign(new Error("Source not found."), { statusCode: 404 });
            if (previous.source.available || this.scanner.isBusy(id)) {
                throw Object.assign(new Error("Only unavailable sources can be re-linked."), { statusCode: 409 });
            }
            const path = await realpath(selectedPath);
            const registered = this.sources.get(path);
            if (registered && registered !== previous) {
                throw Object.assign(new Error("This folder is already a source."), { statusCode: 409 });
            }
            const inspection = await inspectSource(path);
            const source: ImportSource = {
                ...previous.source,
                id: inspection.fingerprint === previous.fingerprint ? id : randomUUID(),
                path, name: basename(path) || path, type: inspection.type,
                cameraModels: inspection.cameraModels, available: true, warning: inspection.warning,
            };
            this.scanner.assertNoIngestion();
            // Replace the map entry in place to preserve the user's source ordering.
            this.sources = new Map([...this.sources].map(([key, entry]) => entry === previous
                ? [path, { source, fingerprint: inspection.fingerprint, inspectionWarning: inspection.warning }] : [key, entry]));
            if (source.id === id) this.scanner.refresh(source);
            this.scanner.sync([...this.sources.values()].map((item) => item.source));
            return { source, collection: this.scanner.snapshot() };
        });
    }

    remove(id: string): Promise<void> {
        return this.serialize(async () => {
            this.scanner.assertNoIngestion();
            if (this.scanner.isBusy(id)) {
                throw Object.assign(new Error("Wait for scanning to finish before removing this source."), { statusCode: 409 });
            }
            for (const [path, entry] of this.sources) {
                if (entry.source.id === id) this.sources.delete(path);
            }
            this.scanner.sync([...this.sources.values()].map((entry) => entry.source));
        });
    }

    async localDataSummary() {
        return { ...await this.scanner.localDataSummary(), sources: this.sources.size };
    }

    clearLocalData() {
        return this.serialize(async () => {
            try { await this.scanner.clearLocalData(); }
            finally {
                // Never let polling automatically re-add sources after a partially failed reset.
                if (!this.scanner.snapshot().shots.length && !this.scanner.snapshot().scans.length) this.sources.clear();
            }
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
