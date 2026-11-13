import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import type { SyncReview } from '../shared/sync';
import { libraryAssetName, parseLibraryAssetName } from '../shared/library';
import type { LibraryCatalogue } from './catalogue';
import type { ShotScanner } from './scanner';
import type { IngestQueue } from './ingestion';
import { inspectLibrary, libraryFileIdentity, within } from './library';
import type { LibraryLocation } from './library';
import { rsyncFile } from './rsync';

interface FileCopy { from: string; to: string; sourceIdentity: string; targetIdentity: string | null; bytes: number }
interface Capture { id: string; filename: string; files: FileCopy[]; metadataIdentity: string; issue?: string }
interface Review { view: SyncReview; library: LibraryLocation; destination: LibraryLocation; captures: Capture[]; generation: number; created: number }
const lifetime = 30 * 60 * 1000;
const sameLocation = (a: LibraryLocation, b: LibraryLocation) => a.path === b.path && a.identity === b.identity && a.mount === b.mount;

// Directory paths enter only through main's native picker. Renderer requests use
// capabilities and clip IDs; jobs capture validated names and identities at review.
export class LibrarySync {
    private destinations = new Map<string, { location: LibraryLocation; created: number }>();
    private reviews = new Map<string, Review>();
    private busy = false;
    constructor(private catalogue: LibraryCatalogue, private scanner: ShotScanner, private queue: IngestQueue,
        private libraryLocation: () => Promise<LibraryLocation>, private transfer = rsyncFile) {}

    async choose(path: string) {
        const location = await this.inspectDestination(path);
        this.expire();
        const token = randomUUID(); this.destinations.set(token, { location, created: Date.now() });
        return { token, path: location.path };
    }
    private async inspectDestination(path: string) {
        try { return await inspectLibrary(path); }
        catch { throw new Error('Sync destination is unavailable. Choose an accessible folder on a mounted volume.'); }
    }
    private expire() {
        for (const [key, value] of this.destinations) if (Date.now() - value.created > lifetime) this.destinations.delete(key);
        for (const [key, value] of this.reviews) if (Date.now() - value.created > lifetime) this.reviews.delete(key);
        while (this.destinations.size >= 32) this.destinations.delete(this.destinations.keys().next().value!);
        while (this.reviews.size >= 32) this.reviews.delete(this.reviews.keys().next().value!);
    }
    private async locations(library: LibraryLocation, destination: LibraryLocation) {
        if (!sameLocation(library, await this.libraryLocation())) throw new Error('Library changed. Review Sync again.');
        if (!sameLocation(destination, await this.inspectDestination(destination.path))) throw new Error('Sync destination changed or is unavailable. Choose it again.');
        if (within(library.path, destination.path)) throw new Error('Choose a Sync destination outside the Library.');
    }
    private protectOriginal(path: string, identity: string | null, source: string) {
        if (this.scanner.snapshot().shots.some(shot => shot.filePath === path)) throw new Error('Sync would overwrite original footage. Choose another destination.');
        if (identity && identity.split(':').slice(0, 2).join(':') === source.split(':').slice(0, 2).join(':')) throw new Error('Sync destination aliases a Library asset. Choose another destination.');
    }
    async preview(ids: string[], destinationToken: string): Promise<SyncReview> {
        if (this.busy) throw new Error('Wait for the current Sync review.');
        this.busy = true;
        try {
            this.expire();
            const choice = this.destinations.get(destinationToken);
            if (!choice) throw new Error('Choose a Sync destination again.');
            const generation = this.queue.workRevision;
            const library = await this.libraryLocation(), destination = choice.location;
            await this.locations(library, destination);
            const collection = await this.catalogue.refresh();
            if (collection.error) throw new Error(collection.error);
            const captures: Capture[] = [];
            for (const id of ids) {
                const shot = collection.shots.find(shot => shot.id === id);
                const capture: Capture = { id, filename: shot?.filename ?? id, files: [], metadataIdentity: '' };
                try {
                    if (!shot) throw new Error('Clip is no longer in the Library.');
                    if (!shot.editable) throw new Error('Clip is already queued.');
                    if (shot.ingestState === 'changes-pending') throw new Error('Commit or Revert changes before Sync.');
                    const source = parseLibraryAssetName(shot.relativePath);
                    if (!source || source.id !== id || source.role !== 'source') throw new Error('Source unavailable.');
                    capture.metadataIdentity = await libraryFileIdentity(join(library.path, libraryAssetName(id, 'metadata', 'json'))) ?? '';
                    if (!capture.metadataIdentity) throw new Error('Metadata unavailable.');
                    for (const name of [shot.relativePath, libraryAssetName(id, 'proxy', 'mov')]) {
                        const from = join(library.path, name), to = join(destination.path, name);
                        const sourceIdentity = await libraryFileIdentity(from);
                        if (!sourceIdentity) throw new Error(name.endsWith('.proxy.mov') ? 'Proxy unavailable.' : 'Source unavailable.');
                        const targetIdentity = await libraryFileIdentity(to);
                        if (targetIdentity && (await lstat(to)).nlink !== 1) throw new Error('Destination is a linked file. Choose another destination.');
                        this.protectOriginal(to, targetIdentity, sourceIdentity);
                        capture.files.push({ from, to, sourceIdentity, targetIdentity, bytes: Number(sourceIdentity.split(':')[2]) });
                    }
                } catch (error) { capture.issue = error instanceof Error ? error.message : String(error); }
                captures.push(capture);
            }
            await this.locations(library, destination);
            if (generation !== this.queue.workRevision) throw new Error('Work was stopped. Review Sync again.');
            const view: SyncReview = { token: randomUUID(), destinationPath: destination.path, format: 'direct-copy', clips: captures.map(c => ({
                id: c.id, filename: c.filename, bytes: c.files.reduce((sum, file) => sum + file.bytes, 0),
                mode: c.files.some(file => file.targetIdentity) ? 'replace' : 'new', issue: c.issue,
            })) };
            this.reviews.set(view.token, { view, library, destination, captures, generation, created: Date.now() });
            return structuredClone(view);
        } finally { this.busy = false; }
    }
    private async validate(capture: Capture, library: LibraryLocation) {
        if (await libraryFileIdentity(join(library.path, libraryAssetName(capture.id, 'metadata', 'json'))) !== capture.metadataIdentity) throw new Error('Library metadata changed. Review Sync again.');
        for (const file of capture.files) {
            if (await libraryFileIdentity(file.from) !== file.sourceIdentity) throw new Error('Library media changed or is unavailable. Review Sync again.');
            const target = await libraryFileIdentity(file.to);
            if (target && (await lstat(file.to)).nlink !== 1) throw new Error('Destination is a linked file. Choose another destination.');
            this.protectOriginal(file.to, target, file.sourceIdentity);
            if (target !== file.targetIdentity) throw new Error('Destination files changed. Review Sync again to approve replacement.');
        }
    }
    async submit(token: string, ids: string[]) {
        if (this.busy) throw new Error('Wait for the current Sync review.');
        this.busy = true;
        try {
            this.expire();
            const review = this.reviews.get(token);
            if (!review || review.generation !== this.queue.workRevision) throw new Error('Review Sync again.');
            const captures = ids.map(id => review.captures.find(c => c.id === id));
            if (!ids.length || new Set(ids).size !== ids.length || captures.some(c => !c || c.issue)) throw new Error('Exclude unavailable clips before Sync.');
            await this.locations(review.library, review.destination);
            const collection = await this.catalogue.snapshot();
            for (const capture of captures as Capture[]) {
                const shot = collection.shots.find(s => s.id === capture.id);
                if (!shot?.editable || shot.ingestState === 'changes-pending') throw new Error('Clips changed. Commit or Revert, then review Sync again.');
                await this.validate(capture, review.library);
            }
            // Re-read drafts after filesystem awaits. A save racing the subsequent
            // synchronous lock is rejected by the organization's own lock guard.
            const latest = await this.catalogue.snapshot();
            if (captures.some(c => { const shot = latest.shots.find(s => s.id === c!.id); return !shot?.editable || shot.ingestState === 'changes-pending'; })) throw new Error('Clips changed. Commit or Revert, then review Sync again.');
            if (review.generation !== this.queue.workRevision) throw new Error('Work was stopped. Review Sync again.');
            const result = this.queue.enqueueLibrary((captures as Capture[]).map(capture => ({ id: capture.id, filename: capture.filename, kind: 'sync',
                execute: async (signal, progress) => {
                    await this.locations(review.library, review.destination); await this.validate(capture, review.library);
                    const total = capture.files.reduce((sum, file) => sum + file.bytes, 0) || 1;
                    let completed = 0;
                    for (const file of capture.files) {
                        signal.throwIfAborted(); await this.locations(review.library, review.destination);
                        if (await libraryFileIdentity(file.from) !== file.sourceIdentity || await libraryFileIdentity(file.to) !== file.targetIdentity) throw new Error('Sync files changed after review. Review Sync again.');
                        this.protectOriginal(file.to, file.targetIdentity, file.sourceIdentity);
                        await this.transfer(file.from, file.to, signal, percent => progress((completed + file.bytes * percent / 100) / total * 99));
                        completed += file.bytes;
                    }
                }
            })), token);
            this.reviews.delete(token); return result;
        } finally { this.busy = false; }
    }
}
