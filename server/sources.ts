import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createHash, randomUUID } from "node:crypto";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImportSource } from "../shared/desktop";

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });

async function exists(path: string, directory: boolean): Promise<boolean> {
    try {
        const info = await stat(path);
        return directory ? info.isDirectory() : info.isFile();
    } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
    }
}

export async function inspectSource(path: string) {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Choose a directory");
    const fingerprint = createHash("sha256").update(`${info.dev}:${info.ino}:${info.birthtimeMs}`);
    const root = join(path, "PRIVATE", "M4ROOT");
    const clipPath = join(root, "CLIP");
    const sony =
        (await exists(clipPath, true)) &&
        ((await exists(join(root, "MEDIAPRO.XML"), false)) ||
            (await exists(join(root, "SUB"), true)) ||
            (await exists(join(root, "THMBNL"), true)));
    const models = new Set<string>();
    let warning: string | undefined;
    if (sony) {
        const metadataFiles: string[] = [];
        const directory = await opendir(clipPath);
        for await (const entry of directory) {
            if (entry.isFile() && !entry.name.startsWith("._") && entry.name.toLowerCase().endsWith(".xml")) {
                metadataFiles.push(entry.name);
                if (metadataFiles.length === 8) break;
            }
        }
        for (const name of metadataFiles.sort()) {
            try {
                const metadataPath = join(clipPath, name);
                const metadataInfo = await stat(metadataPath);
                if (metadataInfo.size > 1024 * 1024) throw new Error("Oversized XML");
                const xml = await readFile(metadataPath, "utf8");
                fingerprint.update(name).update(xml);
                if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid XML");
                const data = parser.parse(xml);
                const device = data.NonRealTimeMeta?.Device;
                if (device?.["@_manufacturer"] === "Sony" && typeof device["@_modelName"] === "string") {
                    models.add(device["@_modelName"]);
                }
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
            return [...this.sources.values()].map((entry) => entry.source);
        });
    }

    remove(id: string): Promise<void> {
        return this.serialize(async () => {
            for (const [path, entry] of this.sources) {
                if (entry.source.id === id) this.sources.delete(path);
            }
        });
    }
}
