import { VIDEO_SAMPLE_SCHEME } from './shots';

export const DRAFT_RETENTION_DAYS = 90;
export const TAG_FIELDS = ['identity', 'project', 'tags'] as const;
export const OPTION_FIELDS = ['identity', 'project'] as const;
export const SCENE_MAX_LENGTH = 80;
export type TagField = typeof TAG_FIELDS[number];
export interface ClipAttributes {
    identity: string | null;
    project: string | null;
    scene: string;
    notes: string;
    tags: string[];
}
// Skip is a draft status, independent of descriptive attributes and editing selection.
export interface ShotOrganization extends ClipAttributes {
    skipped: boolean;
}
export type TagVocabulary = Record<TagField, string[]>;
export interface OptionRemovalPlan {
    reviewToken: string;
    clips: { key: string; name: string; path?: string; status: 'active' | 'saved'; removals: TagVocabulary }[];
}
export type OrganizationAction =
    | { field: TagField; operation: 'add' | 'remove'; value: string }
    | { field: 'notes'; operation: 'set'; value: string }
    | { field: 'scene'; operation: 'set'; value: string }
    | { field: 'skip'; operation: 'set'; value: 'true' | 'false' }
    | { field: 'all'; operation: 'clear'; value: '' };
export const emptyAttributes = (): ClipAttributes => ({ identity: null, project: null, scene: '', notes: '', tags: [] });
export const emptyOrganization = (): ShotOrganization => ({ ...emptyAttributes(), skipped: false });
export const emptyVocabulary = (): TagVocabulary => ({ identity: [], project: [], tags: [] });

export function validateOptionRemovals(value: unknown): TagVocabulary {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !TAG_FIELDS.includes(key as TagField))) throw new Error('Invalid option lists.');
    const lists = value as Record<string, unknown>;
    const result = emptyVocabulary();
    for (const field of TAG_FIELDS) {
        const entries = lists[field];
        if (!Array.isArray(entries) || entries.length > 1000 || entries.some(entry => typeof entry !== 'string')) throw new Error('Invalid option lists.');
        result[field] = [...new Set(entries.map(entry => field === 'tags' ? normalizeTag(entry) : normalizeOption(entry)))];
    }
    if (result.tags.length) throw new Error('Tag suggestions are session-only.');
    return result;
}

export function normalizeOption(value: string): string {
    const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!normalized || [...normalized].length > 128 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
        throw new Error('Enter a name of up to 128 characters.');
    }
    return normalized;
}

export function normalizeTag(value: string): string {
    const normalized = value.trim().normalize('NFC').toLowerCase();
    if (!normalized || [...normalized].length > 64 || !/^[\p{L}\p{N}\p{M}_-]+(?:\/[\p{L}\p{N}\p{M}_-]+)*$/u.test(normalized)) {
        throw new Error('Use up to 64 lowercase letters, numbers, hyphens, underscores, or slash-separated segments.');
    }
    return normalized;
}

export function normalizeScene(value: string): string {
    const normalized = value.normalize('NFC').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').trim().replace(/ +/g, ' ');
    if ([...normalized].length > SCENE_MAX_LENGTH || !/^[\p{L}\p{N}\p{M} .,'-]*$/u.test(normalized) || /[\p{Cc}\p{Cf}]/u.test(value)) {
        throw new Error(`Use up to ${SCENE_MAX_LENGTH} characters: letters, numbers, spaces, apostrophes, commas, periods, or hyphens.`);
    }
    return normalized;
}

export function organizationKey(fingerprint: { scheme: string; value: string }) {
    if (fingerprint.scheme !== VIDEO_SAMPLE_SCHEME || !/^[a-f0-9]{64}$/.test(fingerprint.value)) throw new Error('Invalid video fingerprint.');
    return `${fingerprint.scheme}:${fingerprint.value}`;
}

export function validateOrganizationAction(action: OrganizationAction): OrganizationAction {
    if (action.field === 'scene' && action.operation === 'set' && typeof action.value === 'string') return { ...action, value: normalizeScene(action.value) };
    if (action.field === 'skip' && action.operation === 'set' && ['true', 'false'].includes(action.value)) return action;
    if (action.field === 'all' && action.operation === 'clear' && action.value === '') return action;
    if (action.field === 'notes' && action.operation === 'set' && typeof action.value === 'string' && action.value.length <= 10000) return action;
    if (TAG_FIELDS.includes(action.field as TagField) && ['add', 'remove'].includes(action.operation) && typeof action.value === 'string') {
        return { field: action.field as TagField, operation: action.operation as 'add' | 'remove', value: action.field === 'tags' ? normalizeTag(action.value) : normalizeOption(action.value) };
    }
    throw new Error('Invalid organization change.');
}
