export const DRAFT_RETENTION_DAYS = 90;
export const TAG_FIELDS = ['identity', 'projects', 'context'] as const;
export type TagField = typeof TAG_FIELDS[number];
export interface ShotOrganization {
    identity: string | null;
    projects: string[]; // Zero or one project; array shape retained for draft compatibility.
    context: string[];
    notes: string;
}
export type TagVocabulary = Record<TagField, string[]>;
export type OrganizationAction =
    | { field: TagField; operation: 'add' | 'remove'; value: string }
    | { field: 'notes'; operation: 'set'; value: string }
    | { field: 'all'; operation: 'clear'; value: '' };
export const emptyOrganization = (): ShotOrganization => ({ identity: null, projects: [], context: [], notes: '' });
export const emptyVocabulary = (): TagVocabulary => ({ identity: [], projects: [], context: [] });

export function validateOptionRemovals(value: unknown): TagVocabulary {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !TAG_FIELDS.includes(key as TagField))) throw new Error('Invalid option lists.');
    const lists = value as Record<string, unknown>;
    const result = emptyVocabulary();
    for (const field of TAG_FIELDS) {
        const entries = lists[field];
        if (!Array.isArray(entries) || entries.length > 1000 || entries.some(entry => typeof entry !== 'string')) throw new Error('Invalid option lists.');
        result[field] = [...new Set(entries.map(entry => field === 'context' ? normalizeTag(entry) : normalizeOption(entry)))];
    }
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

export function organizationKey(fingerprint: { scheme: string; value: string }) {
    if (fingerprint.scheme !== 'sampled-sha256-v1' || !/^[a-f0-9]{64}$/.test(fingerprint.value)) throw new Error('Invalid video fingerprint.');
    return `${fingerprint.scheme}:${fingerprint.value}`;
}

export function validateOrganizationAction(action: OrganizationAction): OrganizationAction {
    if (action.field === 'all' && action.operation === 'clear' && action.value === '') return action;
    if (action.field === 'notes' && action.operation === 'set' && typeof action.value === 'string' && action.value.length <= 10000) return action;
    if (TAG_FIELDS.includes(action.field as TagField) && ['add', 'remove'].includes(action.operation) && typeof action.value === 'string') {
        return { field: action.field as TagField, operation: action.operation as 'add' | 'remove', value: action.field === 'context' ? normalizeTag(action.value) : normalizeOption(action.value) };
    }
    throw new Error('Invalid organization change.');
}
