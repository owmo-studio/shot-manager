import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SyncReview } from '../shared/sync';
import { libraryAssetName, parseLibraryAssetName } from '../shared/library';
import type { LibraryCatalogue } from './catalogue';
import type { ShotScanner } from './scanner';
import type { IngestQueue } from './ingestion';
import { inspectLibrary, libraryFileIdentity, readLibraryMetadata, within } from './library';
import { ingestAttributes } from '../shared/ingestion';
import { resolveFormatter } from './resolveExport';
import type { ExportClipPlan, ExportFormatter } from './exportPlan';
import { checkExportDirectories, exportMetadataFilename, exportFileIdentity, exportPath, inspectExportDirectories, publishExportFile, readExportDocument, readExportOwner } from './exportFiles';
import type { ExportDirectories } from './exportFiles';
import type { LibraryLocation } from './library';
import { rsyncFile } from './rsync';
import { DEFAULT_STORAGE_WAIT_SECONDS, withStorageRecovery } from './storageRecovery';
import type { StorageRetryInfo } from './storageRecovery';

interface FileCopy { from: string; to: string; sourceIdentity: string; targetIdentity: string | null; bytes: number; transferred?: boolean }
interface Capture { id: string; filename: string; files: FileCopy[]; metadataIdentity: string; plan?: ExportClipPlan; issue?: string }
interface Review { view: SyncReview; library: LibraryLocation; destination: LibraryLocation; captures: Capture[]; directories: ExportDirectories; generation: number; created: number }
const lifetime = 30 * 60 * 1000;
const sameLocation = (a: LibraryLocation, b: LibraryLocation) => a.path === b.path && a.identity === b.identity && a.mount === b.mount;

// Directory paths enter only through main's native picker. Renderer requests use
// capabilities and clip IDs; jobs capture validated names and identities at review.
export class LibrarySync {
    private destinations = new Map<string, { location: LibraryLocation; created: number }>();
    private reviews = new Map<string, Review>();
    private busy = false;
    private exportOwners = new Map<string, string>();
    constructor(private catalogue: LibraryCatalogue, private scanner: ShotScanner, private queue: IngestQueue,
        private libraryLocation: () => Promise<LibraryLocation>, private transfer = rsyncFile, private formatter: ExportFormatter = resolveFormatter,
        private configuredStorageWait: () => Promise<number> = async () => DEFAULT_STORAGE_WAIT_SECONDS,
        private onStorageRetry: (info: StorageRetryInfo) => void = () => undefined) {}

    async choose(path: string) {
        const location = await this.inspectDestination(path);
        this.expire();
        const token = randomUUID(); this.destinations.set(token, { location, created: Date.now() });
        return { token, path: location.path };
    }
    private async inspectDestination(path: string) {
        try { return await inspectLibrary(path); }
        catch (cause) { throw new Error('Export destination is unavailable. Choose an accessible folder on a mounted volume.', { cause }); }
    }
    private expire() {
        for (const [key, value] of this.destinations) if (Date.now() - value.created > lifetime) this.destinations.delete(key);
        for (const [key, value] of this.reviews) if (Date.now() - value.created > lifetime) this.reviews.delete(key);
        while (this.destinations.size >= 32) this.destinations.delete(this.destinations.keys().next().value!);
        while (this.reviews.size >= 32) this.reviews.delete(this.reviews.keys().next().value!);
    }
    private async locations(library: LibraryLocation, destination: LibraryLocation, signal?: AbortSignal, configuredWait?: number) {
        await withStorageRecovery(async () => {
            if (!sameLocation(library, await this.libraryLocation())) throw new Error('Library changed. Review Export again.');
            if (!sameLocation(destination, await this.inspectDestination(destination.path))) throw new Error('Export destination changed. Choose it again.');
        }, configuredWait ?? await this.configuredStorageWait(), signal, this.onStorageRetry);
        if (within(library.path, destination.path)) throw new Error('Choose a Export destination outside the Library.');
    }
    private protectOriginal(path: string, identity: string | null, source: string) {
        if (this.scanner.snapshot().shots.some(shot => shot.filePath === path)) throw new Error('Export would overwrite original footage. Choose another destination.');
        if (identity && identity.split(':').slice(0, 2).join(':') === source.split(':').slice(0, 2).join(':')) throw new Error('Export destination aliases a Library asset. Choose another destination.');
    }
    private async plan(metadata: Awaited<ReturnType<typeof readLibraryMetadata>>['metadata'], extension: string, destination: string, reserved: Set<string>) {
        let available: ExportClipPlan | undefined;
        for (let length = 8; length <= 64; length += 4) {
            const plan = this.formatter.clip(metadata, extension, length);
            const names = [plan.source, plan.proxy];
            names.forEach(name => exportPath(destination, name));
            if (names.some(name => reserved.has(name.normalize('NFC').toLowerCase()))) continue;
            const sourcePath = exportPath(destination, plan.source);
            const existing = await exportFileIdentity(sourcePath);
            if (existing) {
                let owner = this.exportOwners.get(existing);
                if (!owner) {
                    owner = await readExportOwner(sourcePath);
                    if (await exportFileIdentity(sourcePath) !== existing) throw new Error('Exported source changed during review. Review Export again.');
                    this.exportOwners.set(existing, owner);
                    if (this.exportOwners.size > 1024) this.exportOwners.delete(this.exportOwners.keys().next().value!);
                }
                if (owner === metadata.id) return plan;
                continue; // A different clip already owns this shorter prefix.
            }
            // An orphaned proxy cannot identify the clip that owns this name.
            if (await exportFileIdentity(exportPath(destination, plan.proxy))) continue;
            available ??= plan;
        }
        if (!available) throw new Error('Export filenames conflict. Choose another destination.');
        return available;
    }
    async preview(ids: string[], destinationToken: string): Promise<SyncReview> {
        if (this.busy) throw new Error('Wait for the current Export review.');
        this.busy = true;
        try {
            this.expire();
            const choice = this.destinations.get(destinationToken);
            if (!choice) throw new Error('Choose a Export destination again.');
            const generation = this.queue.workRevision;
            const library = await this.libraryLocation(), destination = choice.location;
            await this.locations(library, destination);
            const directories = await inspectExportDirectories(destination.path);
            const document = await readExportDocument(destination.path, exportMetadataFilename);
            this.formatter.manifest([], destination.path, document.content);
            const collection = await this.catalogue.refresh();
            if (collection.error) throw new Error(collection.error);
            const captures: Capture[] = [], reserved = new Set<string>();
            for (const id of ids) {
                const shot = collection.shots.find(shot => shot.id === id);
                const capture: Capture = { id, filename: shot?.filename ?? id, files: [], metadataIdentity: '' };
                try {
                    if (!shot) throw new Error('Clip is no longer in the Library.');
                    if (!shot.editable) throw new Error('Clip is already queued.');
                    if (shot.ingestState === 'changes-pending') throw new Error('Commit or Revert changes before Export.');
                    const source = parseLibraryAssetName(shot.relativePath);
                    if (!source || source.id !== id || source.role !== 'source') throw new Error('Source unavailable.');
                    const current = await readLibraryMetadata(library, id);
                    if (!shot.organization || JSON.stringify(ingestAttributes(current.metadata)) !== JSON.stringify(ingestAttributes(shot.organization))) throw new Error('Library metadata changed. Refresh and review Export again.');
                    capture.metadataIdentity = current.identity;
                    const plan = await this.plan(current.metadata, source.extension, destination.path, reserved);
                    capture.plan = plan;
                    for (const [name, output] of [[shot.relativePath, plan.source], [libraryAssetName(id, 'proxy', 'mov'), plan.proxy]]) {
                        const from = join(library.path, name), to = exportPath(destination.path, output);
                        const sourceIdentity = await libraryFileIdentity(from);
                        if (!sourceIdentity) throw new Error(name.endsWith('.proxy.mov') ? 'Proxy unavailable.' : 'Source unavailable.');
                        const targetIdentity = await exportFileIdentity(to);
                        this.protectOriginal(to, targetIdentity, sourceIdentity);
                        capture.files.push({ from, to, sourceIdentity, targetIdentity, bytes: Number(sourceIdentity.split(':')[2]) });
                    }
                    for (const name of [plan.source, plan.proxy]) reserved.add(name.normalize('NFC').toLowerCase());
                } catch (error) { capture.issue = error instanceof Error ? error.message : String(error); }
                captures.push(capture);
            }
            await this.locations(library, destination);
            if (generation !== this.queue.workRevision) throw new Error('Work was stopped. Review Export again.');
            const view: SyncReview = { token: randomUUID(), destinationPath: destination.path, format: this.formatter.id, clips: captures.map(c => ({
                id: c.id, filename: c.filename, bytes: c.files.reduce((sum, file) => sum + file.bytes, 0),
                mode: c.files.some(file => file.targetIdentity) ? 'replace' : 'new', issue: c.issue, outputFilename: c.plan?.source,
            })) };
            this.reviews.set(view.token, { view, library, destination, captures, directories, generation, created: Date.now() });
            return structuredClone(view);
        } finally { this.busy = false; }
    }
    private async validate(capture: Capture, library: LibraryLocation) {
        if (await libraryFileIdentity(join(library.path, libraryAssetName(capture.id, 'metadata', 'json'))) !== capture.metadataIdentity) throw new Error('Library metadata changed. Review Export again.');
        if (!capture.plan) throw new Error('Review Export again.');
        for (const file of capture.files) {
            if (await libraryFileIdentity(file.from) !== file.sourceIdentity) throw new Error('Library media changed or is unavailable. Review Export again.');
            const target = await exportFileIdentity(file.to);
            this.protectOriginal(file.to, target, file.sourceIdentity);
            if (target !== file.targetIdentity) throw new Error('Destination files changed. Review Export again to approve replacement.');
        }
    }
    async submit(token: string, ids: string[]) {
        if (this.busy) throw new Error('Wait for the current Export review.');
        this.busy = true;
        try {
            this.expire();
            const review = this.reviews.get(token);
            if (!review || review.generation !== this.queue.workRevision) throw new Error('Review Export again.');
            const captures = ids.map(id => review.captures.find(c => c.id === id));
            if (!ids.length || new Set(ids).size !== ids.length || captures.some(c => !c || c.issue)) throw new Error('Exclude unavailable clips before Export.');
            await this.locations(review.library, review.destination);
            const directories = { ...review.directories };
            await checkExportDirectories(review.destination.path, directories);
            const collection = await this.catalogue.snapshot();
            for (const capture of captures as Capture[]) {
                const shot = collection.shots.find(s => s.id === capture.id);
                if (!shot?.editable || shot.ingestState === 'changes-pending') throw new Error('Clips changed. Commit or Revert, then review Export again.');
                await this.validate(capture, review.library);
            }
            // Re-read drafts after filesystem awaits. A save racing the subsequent
            // synchronous lock is rejected by the organization's own lock guard.
            const latest = await this.catalogue.snapshot();
            if (captures.some(c => { const shot = latest.shots.find(s => s.id === c!.id); return !shot?.editable || shot.ingestState === 'changes-pending'; })) throw new Error('Clips changed. Commit or Revert, then review Export again.');
            if (review.generation !== this.queue.workRevision) throw new Error('Work was stopped. Review Export again.');
            const storageWait = await this.configuredStorageWait();
            const guard = async (signal?: AbortSignal) => {
                await this.locations(review.library, review.destination, signal, storageWait);
                await checkExportDirectories(review.destination.path, directories);
            };
            const result = this.queue.enqueueLibrary((captures as Capture[]).map(capture => ({ id: capture.id, filename: capture.filename, kind: 'sync',
                execute: async (signal, progress) => {
                    await this.locations(review.library, review.destination, signal, storageWait);
                    await checkExportDirectories(review.destination.path, directories, true, () => this.locations(review.library, review.destination, signal, storageWait));
                    await this.validate(capture, review.library);
                    // Read the latest document when this serial Export job starts,
                    // including rows written by earlier submissions to this folder.
                    const document = await readExportDocument(review.destination.path, exportMetadataFilename);
                    const content = this.formatter.manifest([capture.plan!], review.destination.path, document.content);
                    const total = capture.files.reduce((sum, file) => sum + file.bytes, 0) || 1;
                    let completed = 0;
                    for (const file of capture.files) {
                        signal.throwIfAborted(); await guard(signal);
                        if (await libraryFileIdentity(file.from) !== file.sourceIdentity || await exportFileIdentity(file.to) !== file.targetIdentity) throw new Error('Export files changed after review. Review Export again.');
                        this.protectOriginal(file.to, file.targetIdentity, file.sourceIdentity);
                        if (!file.transferred) {
                            await this.transfer(file.from, file.to, signal, percent => progress((completed + file.bytes * percent / 100) / total * 99));
                            await guard();
                            file.targetIdentity = await exportFileIdentity(file.to);
                            file.transferred = true;
                        }
                        completed += file.bytes;
                    }
                    // Publish the row only after this clip's media has succeeded.
                    if (await libraryFileIdentity(join(review.library.path, libraryAssetName(capture.id, 'metadata', 'json'))) !== capture.metadataIdentity) throw new Error('Library metadata changed during Export. Review Export again.');
                    await publishExportFile(review.destination.path, exportMetadataFilename,
                        content, document.identity, signal, guard);
                }
            })), token);
            this.reviews.delete(token); return result;
        } finally { this.busy = false; }
    }
}
