import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DRAFT_RETENTION_DAYS, emptyOrganization, emptyVocabulary, normalizeOption, normalizeTag, organizationKey, TAG_FIELDS, validateOptionRemovals, validateOrganizationAction } from '../shared/organization';
import type { OrganizationAction, ShotOrganization, TagVocabulary } from '../shared/organization';
import type { VideoFingerprint } from '../shared/shots';

interface DraftRecord { data: ShotOrganization; lastScannedAt: number; lastEditedAt: number; previousProjects?: string[] }
interface OrganizationState { version: 1 | 2 | 3; vocabulary: TagVocabulary; drafts: Record<string, DraftRecord> }

export class OrganizationStore {
    private state?: OrganizationState;
    private pending: Promise<unknown> = Promise.resolve();
    constructor(private path?: string, private now = () => Date.now()) {}

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => undefined);
        return result;
    }

    private async load() {
        if (this.state) return this.state;
        let state: OrganizationState = { version: 3, vocabulary: emptyVocabulary(), drafts: {} };
        if (this.path) {
            try {
                state = JSON.parse(await readFile(this.path, 'utf8'));
                if (![1, 2, 3].includes(state.version) || !state.vocabulary || !state.drafts || typeof state.drafts !== 'object' || Array.isArray(state.drafts)) throw new Error('Invalid state');
                for (const field of TAG_FIELDS) {
                    if (!Array.isArray(state.vocabulary[field]) || state.vocabulary[field].some(value => typeof value !== 'string' || (field === 'context' ? normalizeTag(value) : normalizeOption(value)) !== value)) throw new Error('Invalid vocabulary');
                }
                for (const [key, record] of Object.entries(state.drafts)) {
                    if (!/^sampled-sha256-v1:[a-f0-9]{64}$/.test(key) || !record || !Number.isFinite(record.lastScannedAt) || !Number.isFinite(record.lastEditedAt)) throw new Error('Invalid draft');
                    const data = record.data;
                    if (!data || !(data.identity === null || (typeof data.identity === 'string' && normalizeOption(data.identity) === data.identity)) ||
                        typeof data.notes !== 'string' || data.notes.length > 10000) throw new Error('Invalid draft');
                    for (const field of ['projects', 'context'] as const) {
                        if (!Array.isArray(data[field]) || data[field].some(value => typeof value !== 'string' || (field === 'context' ? normalizeTag(value) : normalizeOption(value)) !== value)) throw new Error('Invalid draft');
                    }
                }
                let migrated = state.version !== 3 || Object.hasOwn(state.vocabulary, 'colors') || Object.hasOwn(state.vocabulary, 'colorVersion');
                state.vocabulary = { identity: state.vocabulary.identity, projects: state.vocabulary.projects, context: state.vocabulary.context };
                for (const record of Object.values(state.drafts)) {
                    if (record.data.projects.length > 1) {
                        record.previousProjects ??= [...record.data.projects];
                        record.data.projects = record.data.projects.slice(0, 1);
                        migrated = true;
                    }
                }
                if (migrated) { state.version = 3; await this.save(state); }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read saved tags. Existing data has been preserved.');
            }
        }
        this.state = state;
        return state;
    }

    private async save(next: OrganizationState, validate: () => boolean = () => true) {
        if (!validate()) throw new Error('Selected clips are now locked.');
        if (this.path) {
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = `${this.path}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flush: true });
                if (!validate()) throw new Error('Selected clips are now locked.');
                await rename(temporary, this.path);
            } finally { await unlink(temporary).catch(() => undefined); }
        }
        this.state = next;
    }

    vocabulary() { return this.serialize(async () => structuredClone((await this.load()).vocabulary)); }

    scanned(fingerprint: VideoFingerprint, signal: AbortSignal) {
        return this.serialize(async () => {
            const next = structuredClone(await this.load());
            const key = organizationKey(fingerprint);
            const record = next.drafts[key] ?? { data: emptyOrganization(), lastScannedAt: 0, lastEditedAt: 0 };
            record.lastScannedAt = this.now();
            next.drafts[key] = record;
            this.collectOptions(next.vocabulary, record.data);
            await this.save(next, () => !signal.aborted);
            return structuredClone(record.data);
        });
    }

    update(fingerprints: VideoFingerprint[], change: OrganizationAction, validate: () => boolean) {
        return this.serialize(async () => {
            let action = validateOrganizationAction(change);
            const next = structuredClone(await this.load());
            if (action.field === 'identity' || action.field === 'projects') {
                const existing = next.vocabulary[action.field].find(value => value.toLocaleLowerCase() === action.value.toLocaleLowerCase());
                if (existing) action = { ...action, value: existing };
            }
            if (!validate()) throw new Error('Selected clips are now locked.');
            const keys = [...new Set(fingerprints.map(organizationKey))];
            if (!keys.length) throw new Error('Select a clip first.');
            for (const key of keys) {
                const record = next.drafts[key];
                if (!record) throw new Error('Draft unavailable. Refresh the source to retry.');
                if (action.field === 'all') { record.data = emptyOrganization(); delete record.previousProjects; }
                else if (action.field === 'notes') record.data.notes = action.value;
                else if (action.field === 'identity') {
                    if (action.operation === 'add') record.data.identity = action.value;
                    else if (record.data.identity === action.value) record.data.identity = null;
                } else if (action.field === 'projects') {
                    record.data.projects = action.operation === 'add' ? [action.value] : record.data.projects.filter(tag => tag !== action.value);
                } else {
                    record.data[action.field] = action.operation === 'add'
                        ? [...new Set([...record.data[action.field], action.value])]
                        : record.data[action.field].filter(tag => tag !== action.value);
                }
                record.lastEditedAt = this.now();
            }
            if (action.field !== 'notes' && action.field !== 'all' && action.operation === 'add') {
                next.vocabulary[action.field] = [...new Set([...next.vocabulary[action.field], action.value])].sort();
            }
            await this.save(next, validate);
            return { drafts: Object.fromEntries(keys.map(key => [key, structuredClone(next.drafts[key].data)])), vocabulary: structuredClone(next.vocabulary) };
        });
    }

    clearOptions() {
        return this.serialize(async () => {
            const next = structuredClone(await this.load());
            next.vocabulary = emptyVocabulary();
            await this.save(next);
        });
    }

    removeOptions(value: unknown) {
        return this.serialize(async () => {
            const removals = validateOptionRemovals(value);
            const next = structuredClone(await this.load());
            for (const field of TAG_FIELDS) {
                const deleted = new Set(removals[field]);
                next.vocabulary[field] = next.vocabulary[field].filter(option => !deleted.has(option));
            }
            await this.save(next);
            return structuredClone(next.vocabulary);
        });
    }

    private collectOptions(vocabulary: TagVocabulary, data: ShotOrganization) {
        for (const field of TAG_FIELDS) {
            const values = field === 'identity' ? data.identity ? [data.identity] : [] : data[field];
            vocabulary[field] = [...new Set([...vocabulary[field], ...values])].sort();
        }
    }

    // Run at session end, after scans have had the opportunity to renew returning drafts.
    prune() {
        return this.serialize(async () => {
            const next = structuredClone(await this.load());
            const cutoff = this.now() - DRAFT_RETENTION_DAYS * 86400000;
            let removed = 0;
            for (const [key, record] of Object.entries(next.drafts)) {
                if (Math.max(record.lastScannedAt, record.lastEditedAt) <= cutoff) { delete next.drafts[key]; removed++; }
            }
            if (removed) await this.save(next);
            return removed;
        });
    }
}
