import type { VideoShot } from '../../shared/shots';
import { deviceLabel } from './mediaInfo';

export interface ClipFilters {
    search: string;
    identity: string;
    projects: string[];
    devices: string[];
    tags: string[];
}
export const emptyClipFilters = (): ClipFilters => ({ search: '', identity: '', projects: [], devices: [], tags: [] });
export type Facet = 'identity' | 'projects' | 'devices' | 'tags';
const cascadeOrder: Facet[] = ['identity', 'projects', 'tags', 'devices'];
export const UNASSIGNED_IDENTITY = '\u0000unassigned';
export function facetValues(shot: VideoShot, facet: Facet): string[] {
    const data = shot.organization;
    if (facet === 'identity') return [data?.identity || UNASSIGNED_IDENTITY];
    if (facet === 'projects') return data?.project ? [data.project] : [];
    if (facet === 'devices') return [deviceLabel(shot.metadata.device, true) ?? 'Unknown'];
    return data?.tags ?? [];
}
function searchableText(shot: VideoShot) {
    const data = shot.organization;
    return [shot.filename, data?.scene, data?.group, data?.camera, data?.notes, data?.project, ...(data?.tags ?? [])].filter(Boolean).join(' ').normalize('NFC').toLowerCase();
}

export function clipQueryDataChanged(previous: VideoShot, current: VideoShot) {
    if (previous === current) return false;
    return searchableText(previous) !== searchableText(current) || cascadeOrder.some(facet => {
        const before = facetValues(previous, facet);
        const after = facetValues(current, facet);
        return before.length !== after.length || before.some((value, index) => value !== after[index]);
    });
}

export function matchesClipFilters(shot: VideoShot, filters: ClipFilters, except?: Facet) {
    const words = filters.search.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
        const text = searchableText(shot);
        if (!words.every(word => text.includes(word))) return false;
    }
    return (['identity', 'projects', 'devices', 'tags'] as const).every(facet => {
        if (facet === except) return true;
        const selected = facet === 'identity' ? (filters.identity ? [filters.identity] : []) : filters[facet];
        return !selected.length || facetValues(shot, facet).some(value => selected.includes(value));
    });
}
export function filterOptions(shots: VideoShot[], filters: ClipFilters, facet: Facet) {
    const counts = new Map<string, number>();
    // Search narrows results independently; only earlier facets shape options.
    const upstream = { ...filters, search: '' };
    for (const field of cascadeOrder.slice(cascadeOrder.indexOf(facet))) {
        if (field === 'identity') upstream.identity = '';
        else upstream[field] = [];
    }
    for (const shot of shots) {
        if (!matchesClipFilters(shot, upstream)) continue;
        for (const value of new Set(facetValues(shot, facet))) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const selected = facet === 'identity' ? (filters.identity ? [filters.identity] : []) : filters[facet];
    for (const value of selected) if (!counts.has(value)) counts.set(value, 0);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
}
