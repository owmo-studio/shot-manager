import { createHash, randomUUID } from "node:crypto";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImportSource } from "../shared/desktop";
import { ShotScanner } from "./scanner";
import { findSonyLayout } from "./sony";
import { readEmbeddedContainer } from "./embedded";
import { sonyMetadata } from "./videoMetadata";


export async function inspectSource(path: string) {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Choose a directory");
    const fingerprint = createHash("sha256").update(`${info.dev}:${info.ino}:${info.birthtimeMs}`);
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
                fingerprint.update(name);
                for (const xml of embedded.xml) fingerprint.update(xml);
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
        fingerprint: fingerprint.digest("hex"),
        warning,
    };
}

export class SourceRegistry {
    readonly scanner: ShotScanner;

    constructor(thumbnailCacheDirectory?: string, fingerprintDirectory?: string) {
        this.scanner = new ShotScanner(thumbnailCacheDirectory, fingerprintDirectory);
    }
    private sources = new Map<string, { source: ImportSource; fingerprint: string }>();
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
                id: existing?.fingerprint === inspection.fingerprint ? existing.source.id : randomUUID(),
                name: basename(path) || path,
                path,
                type: inspection.type,
                cameraModels: inspection.cameraModels,
                available: true,
                warning: inspection.warning,
            };
            this.sources.set(path, { source, fingerprint: inspection.fingerprint });
            this.scanner.sync([...this.sources.values()].map((entry) => entry.source));
            return source;
        });
    }

    list(): Promise<ImportSource[]> {
        return this.serialize(async () => {
            for (const [path, entry] of this.sources) {
                try {
                    const inspection = await inspectSource(path);
                    entry.source = {
                        ...entry.source,
                        id: entry.fingerprint === inspection.fingerprint ? entry.source.id : randomUUID(),
                        type: inspection.type,
                        cameraModels: inspection.cameraModels,
                        available: true,
                        warning: inspection.warning,
                    };
                    entry.fingerprint = inspection.fingerprint;
                } catch (error) {
                    const missing = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
                    entry.source = {
                        ...entry.source,
                        available: false,
                        warning: missing
                            ? "Source not found. It may have been disconnected, moved, or renamed. Please resolve to continue."
                            : "Source is inaccessible. Check folder permissions.",
                    };
                }
            }
            const sources = [...this.sources.values()].map((entry) => entry.source);
            this.scanner.sync(sources);
            return sources;
        });
    }

    refresh(id: string) {
        return this.serialize(async () => {
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
            entry.source = {
                ...entry.source,
                id: entry.fingerprint === inspection.fingerprint ? id : randomUUID(),
                type: inspection.type,
                cameraModels: inspection.cameraModels,
                available: true,
                warning: inspection.warning,
            };
            entry.fingerprint = inspection.fingerprint;
            if (entry.source.id === id) this.scanner.refresh(entry.source);
            this.scanner.sync([...this.sources.values()].map((item) => item.source));
            return { source: entry.source, collection: this.scanner.snapshot() };
        });
    }

    relink(id: string, selectedPath: string) {
        return this.serialize(async () => {
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
            // Replace the map entry in place to preserve the user's source ordering.
            this.sources = new Map([...this.sources].map(([key, entry]) => entry === previous
                ? [path, { source, fingerprint: inspection.fingerprint }] : [key, entry]));
            if (source.id === id) this.scanner.refresh(source);
            this.scanner.sync([...this.sources.values()].map((item) => item.source));
            return { source, collection: this.scanner.snapshot() };
        });
    }

    remove(id: string): Promise<void> {
        return this.serialize(async () => {
            if (this.scanner.isBusy(id)) {
                throw Object.assign(new Error("Wait for scanning to finish before removing this source."), { statusCode: 409 });
            }
            for (const [path, entry] of this.sources) {
                if (entry.source.id === id) this.sources.delete(path);
            }
            this.scanner.sync([...this.sources.values()].map((entry) => entry.source));
        });
    }

}
