import { createHash, randomUUID } from "node:crypto";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImportSource } from "../shared/desktop";
import { ShotScanner } from "./scanner";
import { findSonyLayout } from "./sony";
import { readEmbeddedContainer } from "./embedded";
import { sonyMetadata } from "./videoMetadata";
import type { TagVocabulary } from "../shared/organization";


function rootFingerprint(info: { dev: number; ino: number; birthtimeMs: number }) {
    return createHash('sha256').update(`${info.dev}:${info.ino}:${info.birthtimeMs}`).digest('hex');
}

export async function inspectSource(path: string) {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Choose a directory");
    const fingerprint = rootFingerprint(info);
    const layout = await findSonyLayout(path);
    const sony = layout !== null;
    const models = new Set<string>();
    let warning: string | undefined;
    if (layout) {
        const clipPath = layout.clips;
        const metadataFiles: string[] = [];
        const directory = await opendir(clipPath);
        for await (const entry of directory) {
            if (entry.isFile() && !entry.name.startsWith(".") && entry.name.toLowerCase().endsWith(".mp4")) {
                metadataFiles.push(entry.name);
                if (metadataFiles.length === 8) break;
            }
        }
        for (const name of metadataFiles.sort()) {
            try {
                const metadataPath = join(clipPath, name);
                const embedded = await readEmbeddedContainer(metadataPath);
                const sony = sonyMetadata(embedded);
                if (sony?.model) models.add(sony.model);
                if (embedded.warnings.length) warning = "Some camera metadata could not be read.";
            } catch {
                warning = "Some camera metadata could not be read.";
            }
        }
    }
    return {
        type: sony ? ("sony" as const) : ("folder" as const),
        cameraModels: [...models].sort(),
        fingerprint,
        warning,
    };
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
            this.scanner.assertNoIngestion();
            const path = await realpath(selectedPath);
            const inspection = await inspectSource(path);
            const existing = this.sources.get(path);
            const source: ImportSource = {
                id: existing?.fingerprint === inspection.fingerprint ? existing.source.id : randomUUID(),
                name: basename(path) || path,
                path,
                type: inspection.type,
                cameraModels: inspection.cameraModels,
                available: true,
                warning: inspection.warning,
            };
            this.scanner.assertNoIngestion();
            this.sources.set(path, { source, fingerprint: inspection.fingerprint, inspectionWarning: inspection.warning });
            this.scanner.sync([...this.sources.values()].map((entry) => entry.source));
            return source;
        });
    }

    // Listing never touches source media or waits behind source mutations.
    list(): ImportSource[] { return structuredClone([...this.sources.values()].map(entry => entry.source)); }

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
        this.availabilityCheck = Promise.all([...this.sources].map(async ([path, entry]) => {
            const expectedSource = entry.source;
            let inspection: Awaited<ReturnType<typeof inspectSource>> | undefined;
            let warning: string | undefined;
            try {
                const info = await stat(path);
                if (!info.isDirectory()) throw Object.assign(new Error('Source is not a folder'), {code:'ENOTDIR'});
                // Re-inspect camera presentation only if the actual source root changed.
                if (rootFingerprint(info) !== entry.fingerprint) inspection = await inspectSource(path);
            } catch (error) {
                warning = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
                    ? 'Source not found. It may have been disconnected, moved, or renamed. Please resolve to continue.'
                    : 'Source is inaccessible. Check folder permissions.';
            }
            await this.serialize(async () => {
                // A slow check must not resurrect a removed/re-linked source or undo a reset.
                if (this.closed || this.sources.get(path) !== entry || entry.source !== expectedSource) return;
                const available = !warning;
                if (!inspection && entry.source.available === available && (available || entry.source.warning === warning)) return;
                if (inspection) {
                    entry.fingerprint = inspection.fingerprint;
                    entry.inspectionWarning = inspection.warning;
                }
                entry.source = { ...entry.source, ...(inspection ? {id:randomUUID(),type:inspection.type,cameraModels:inspection.cameraModels} : {}),
                    available, warning: warning ?? entry.inspectionWarning };
                this.scanner.sync([...this.sources.values()].map(item => item.source));
            });
        })).then(() => undefined).finally(() => { this.availabilityCheck = undefined; });
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
