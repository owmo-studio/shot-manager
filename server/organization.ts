import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DRAFT_RETENTION_DAYS, emptyOrganization, emptyVocabulary, normalizeOption, normalizeTag, organizationKey, TAG_FIELDS, validateOptionRemovals, validateOrganizationAction } from '../shared/organization';
import type { OptionRemovalPlan, OrganizationAction, ShotOrganization, TagVocabulary } from '../shared/organization';
import { VIDEO_SAMPLE_SCHEME } from '../shared/shots';
import type { VideoFingerprint } from '../shared/shots';

const draftKeyPattern = new RegExp(`^${VIDEO_SAMPLE_SCHEME}:[a-f0-9]{64}$`);

interface DraftRecord { data: ShotOrganization; lastScannedAt: number; lastEditedAt: number; previousProjects?: string[]; clip?: { name: string; path: string } }
interface OrganizationState { version: 1 | 2 | 3 | 4 | 5; vocabulary: TagVocabulary; drafts: Record<string, DraftRecord> }

export class OrganizationStore {
    private state?: OrganizationState;
    private pending: Promise<unknown> = Promise.resolve();
    private scanTouches = new Map<string, { scannedAt: number; clip?: { name: string; path: string } }>();
    private vocabularyKey = '';
    private optionsRevision = 0;
    get vocabularyRevision() { return this.optionsRevision; }
    constructor(private path?: string, private now = () => Date.now()) {}

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => undefined);
        return result;
    }

    private async load() {
        if (this.state) return this.state;
        let state: OrganizationState = { version: 5, vocabulary: emptyVocabulary(), drafts: {} };
        if (this.path) {
            try {
                state = JSON.parse(await readFile(this.path, 'utf8'));
                if (![1, 2, 3, 4, 5].includes(state.version) || !state.vocabulary || !state.drafts || typeof state.drafts !== 'object' || Array.isArray(state.drafts)) throw new Error('Invalid state');
                for (const field of TAG_FIELDS) {
                    if (!Array.isArray(state.vocabulary[field]) || state.vocabulary[field].some(value => typeof value !== 'string' || (field === 'context' ? normalizeTag(value) : normalizeOption(value)) !== value)) throw new Error('Invalid vocabulary');
                }
                for (const [key, record] of Object.entries(state.drafts)) {
                    if (!draftKeyPattern.test(key) || !record || !Number.isFinite(record.lastScannedAt) || !Number.isFinite(record.lastEditedAt)) throw new Error('Invalid draft');
                    const data = record.data;
                    if (state.version < 5 && data && !Object.hasOwn(data, 'skipped')) data.skipped = false;
                    if (record.clip && (typeof record.clip.name !== 'string' || typeof record.clip.path !== 'string')) throw new Error('Invalid clip reference');
                    if (!data || !(data.identity === null || (typeof data.identity === 'string' && normalizeOption(data.identity) === data.identity)) ||
                        typeof data.skipped !== 'boolean' || typeof data.notes !== 'string' || data.notes.length > 10000) throw new Error('Invalid draft');
                    for (const field of ['projects', 'context'] as const) {
                        if (!Array.isArray(data[field]) || data[field].some(value => typeof value !== 'string' || (field === 'context' ? normalizeTag(value) : normalizeOption(value)) !== value)) throw new Error('Invalid draft');
                    }
                }
                let migrated = state.version !== 5 || Object.hasOwn(state.vocabulary, 'colors') || Object.hasOwn(state.vocabulary, 'colorVersion');
                state.vocabulary = { identity: state.vocabulary.identity, projects: state.vocabulary.projects, context: [] };
                for (const record of Object.values(state.drafts)) {
                    if (record.data.projects.length > 1) {
                        record.previousProjects ??= [...record.data.projects];
                        record.data.projects = record.data.projects.slice(0, 1);
                        migrated = true;
                    }
                }
                if (migrated) { state.version = 5; await this.save(state); }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read saved tags. Existing data has been preserved.');
            }
        }
        this.state = state;
        this.vocabularyKey = JSON.stringify([state.vocabulary.identity, state.vocabulary.projects]);
        return state;
    }

    private async nextState() {
        const next = structuredClone(await this.load());
        for (const [key, touch] of this.scanTouches) {
            const record = next.drafts[key] ?? { data: emptyOrganization(), lastScannedAt: 0, lastEditedAt: 0 };
            record.lastScannedAt = touch.scannedAt;
            if (touch.clip) record.clip = touch.clip;
            next.drafts[key] = record;
        }
        return next;
    }

    flushScans() {
        return this.serialize(async () => {
            if (this.scanTouches.size) await this.save(await this.nextState());
        });
    }

    private async save(next: OrganizationState, validate: () => boolean = () => true) {
        if (!validate()) throw new Error('Selected clips are now locked.');
        next.vocabulary.context = [];
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
        this.scanTouches.clear();
        const key = JSON.stringify([next.vocabulary.identity, next.vocabulary.projects]);
        if (key !== this.vocabularyKey) { this.vocabularyKey = key; this.optionsRevision++; }
    }

    private options(state: OrganizationState): TagVocabulary {
        return { ...structuredClone(state.vocabulary), context: [] };
    }

    vocabulary() { return this.serialize(async () => this.options(await this.load())); }

    recordCount() { return this.serialize(async () => new Set([...Object.keys((await this.load()).drafts), ...this.scanTouches.keys()]).size); }

    reset() {
        return this.serialize(async () => {
            await this.save({ version: 5, vocabulary: emptyVocabulary(), drafts: {} });
        });
    }

    scanned(fingerprint: VideoFingerprint, signal: AbortSignal, clip?: { name: string; path: string }) {
        return this.serialize(async () => {
            signal.throwIfAborted();
            const state = await this.load();
            signal.throwIfAborted();
            const key = organizationKey(fingerprint);
            const data = state.drafts[key]?.data ?? emptyOrganization();
            this.scanTouches.set(key, { scannedAt: this.now(), clip });
            const missingOptions = (data.identity && !state.vocabulary.identity.includes(data.identity)) ||
                data.projects.some(project => !state.vocabulary.projects.includes(project));
            if (this.scanTouches.size >= 64 || missingOptions) {
                const next = await this.nextState();
                this.collectOptions(next.vocabulary, data);
                await this.save(next, () => !signal.aborted);
            }
            return structuredClone(data);
        });
    }

    update(fingerprints: VideoFingerprint[], change: OrganizationAction, validate: () => boolean) {
        return this.serialize(async () => {
            let action = validateOrganizationAction(change);
            const next = await this.nextState();
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
                if (action.field === 'skip') record.data.skipped = action.value === 'true';
                else if (action.field === 'all') { record.data = { ...emptyOrganization(), skipped: record.data.skipped }; delete record.previousProjects; }
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
            if (action.field !== 'notes' && action.field !== 'all' && action.field !== 'skip' && action.operation === 'add') {
                next.vocabulary[action.field] = [...new Set([...next.vocabulary[action.field], action.value])].sort();
            }
            await this.save(next, validate);
            return { drafts: Object.fromEntries(keys.map(key => [key, structuredClone(next.drafts[key].data)])), vocabulary: this.options(next) };
        });
    }

    clearOptions() {
        return this.serialize(async () => {
            const next = await this.nextState();
            next.vocabulary = emptyVocabulary();
            await this.save(next);
        });
    }

    private removalPlan(state: OrganizationState, removals: TagVocabulary, active: Set<string>): OptionRemovalPlan {
        const clips: OptionRemovalPlan['clips'] = [];
        const versions: unknown[] = [];
        for (const [key, record] of Object.entries(state.drafts).sort(([a], [b]) => a.localeCompare(b))) {
            const removed = emptyVocabulary();
            removed.identity = record.data.identity && removals.identity.includes(record.data.identity) ? [record.data.identity] : [];
            removed.projects = [...new Set([...record.data.projects, ...(record.previousProjects ?? [])])].filter(value => removals.projects.includes(value));
            removed.context = record.data.context.filter(value => removals.context.includes(value));
            if (!TAG_FIELDS.some(field => removed[field].length)) continue;
            clips.push({ key, name: record.clip?.name ?? `Saved clip ${key.slice(-12)}`, path: record.clip?.path, status: active.has(key) ? 'active' : 'saved', removals: removed });
            versions.push([key, record.data, record.previousProjects, record.clip]);
        }
        return { clips, reviewToken: createHash('sha256').update(JSON.stringify([removals, versions, clips.map(clip => clip.status)])).digest('hex') };
    }

    previewOptions(value: unknown, active = new Set<string>()) {
        return this.serialize(async () => this.removalPlan(await this.nextState(), validateOptionRemovals(value), active));
    }

    removeOptions(value: unknown, reviewToken: string, validate: () => boolean = () => true, active = new Set<string>()) {
        return this.serialize(async () => {
            const removals = validateOptionRemovals(value);
            const next = await this.nextState();
            const plan = this.removalPlan(next, removals, active);
            if (plan.reviewToken !== reviewToken) throw Object.assign(new Error('Affected clips changed. Review the removal again.'), { statusCode: 409 });
            for (const field of TAG_FIELDS) {
                const deleted = new Set(removals[field]);
                next.vocabulary[field] = next.vocabulary[field].filter(option => !deleted.has(option));
            }
            for (const { key } of plan.clips) {
                const record = next.drafts[key];
                if (record.data.identity && removals.identity.includes(record.data.identity)) record.data.identity = null;
                record.data.projects = record.data.projects.filter(value => !removals.projects.includes(value));
                record.data.context = record.data.context.filter(value => !removals.context.includes(value));
                if (record.previousProjects) record.previousProjects = record.previousProjects.filter(value => !removals.projects.includes(value));
                record.lastEditedAt = this.now();
            }
            await this.save(next, validate);
            return { vocabulary: this.options(next), drafts: Object.fromEntries(Object.entries(next.drafts).map(([key, record]) => [key, structuredClone(record.data)])) };
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
            const next = await this.nextState();
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
