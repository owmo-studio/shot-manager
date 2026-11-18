import { useState } from 'react';
import type { VideoShot } from '../../shared/shots';
import { emptyClipFilters, filterOptions, UNASSIGNED_IDENTITY } from './clipFilters';
import type { ClipFilters, Facet } from './clipFilters';
import { FilterDropdown } from './FilterDropdown';

const inputStyle = 'w-full min-w-0 rounded-md border border-white/15 bg-[#1b2029] px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-400 placeholder:text-zinc-600';
const queryActionStyle = 'text-xs text-zinc-400 transition enabled:cursor-pointer enabled:hover:text-white focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-default disabled:opacity-40';
export function ClipFilterPanel({ shots, filters, onChange, onReapply, canReapply }: {
    shots: VideoShot[]; filters: ClipFilters; onChange: (filters: ClipFilters) => void; onReapply: () => void; canReapply: boolean;
}) {
    const [resetRevision, setResetRevision] = useState(0);
    const toggle = (field: 'projects' | 'devices' | 'tags', value: string) => onChange({
        ...filters, [field]: filters[field].includes(value) ? filters[field].filter(item => item !== value) : [...filters[field], value],
    });
    function choices(field: Exclude<Facet, 'identity'>) {
        const options = filterOptions(shots, filters, field);
        const noChoice = options.filter(([, count]) => count > 0).length <= 1;
        return <ul aria-label={`${field === 'devices' ? 'Device' : field === 'projects' ? 'Project' : 'Tag'} filters`} className="max-h-52 space-y-0.5 overflow-y-auto">
            {options.map(([value]) => <li key={value}>
                <button type="button" role="checkbox" aria-checked={filters[field].includes(value)}
                    disabled={noChoice && !filters[field].includes(value)}
                    aria-label={`Filter clips by ${field === 'devices' ? 'device' : field === 'projects' ? 'project' : 'tag'}: ${value}`}
                    aria-pressed={filters[field].includes(value)} onClick={() => toggle(field, value)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs enabled:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40 disabled:cursor-not-allowed">
                    <span aria-hidden="true" className={`grid size-3.5 shrink-0 place-items-center rounded-sm border ${filters[field].includes(value) ? 'border-zinc-400 bg-white/10 text-white' : 'border-zinc-600'}`}>
                        {filters[field].includes(value) && '✓'}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={value}>{value}</span>
                </button>
            </li>)}
            {!options.length && <li className="px-2 py-1 text-xs text-zinc-500">No matches</li>}
        </ul>;
    }
    const identities = filterOptions(shots, filters, 'identity');
    const availableIdentities = identities.filter(([, count]) => count > 0);
    const hasFilters = !!filters.identity || !!filters.projects.length || !!filters.tags.length || !!filters.devices.length;
    return <section aria-label="Filters" className="space-y-5">
        <div className="space-y-2">
            <h2 className="text-sm font-medium text-zinc-200">Search</h2>
            <input type="search" aria-label="Search clips" placeholder="Search clips…" className={inputStyle}
                value={filters.search} onChange={event => onChange({ ...filters, search: event.target.value })} />
        </div>
        <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-zinc-200">Filter By</h2>
            <div className="flex items-center gap-3">
                <button type="button" aria-label="Refresh search and filters" className={queryActionStyle}
                    disabled={!canReapply} onClick={onReapply}>Refresh</button>
                <button type="button" aria-label="Clear filters" className={queryActionStyle} disabled={!hasFilters}
                    onClick={() => { onChange({ ...emptyClipFilters(), search: filters.search }); setResetRevision(value => value + 1); }}>Clear</button>
            </div>
        </div>
        <div className="space-y-2">
            <span className="block text-xs text-zinc-400">Identity</span>
            <select aria-label="Filter by Identity" className={`${inputStyle} disabled:opacity-40 disabled:cursor-not-allowed`} value={filters.identity || (availableIdentities.length === 1 ? availableIdentities[0][0] : '')}
                disabled={!filters.identity && availableIdentities.length <= 1}
                onChange={event => onChange({ ...filters, identity: event.target.value })}>
                <option value="">All</option>
                {identities.map(([value]) => <option key={value} value={value}>{value === UNASSIGNED_IDENTITY ? 'Unassigned' : value}</option>)}
            </select>
        </div>
        <FilterDropdown key={`projects-${resetRevision}`} label="Project" options={filterOptions(shots, filters, 'projects')}
            selected={filters.projects} onToggle={value => toggle('projects', value)} />
        <FilterDropdown key={`tags-${resetRevision}`} label="Tags" options={filterOptions(shots, filters, 'tags')}
            selected={filters.tags} onToggle={value => toggle('tags', value)} />
        <div className="space-y-2"><h2 className="text-xs text-zinc-400">Device</h2>{choices('devices')}</div>
    </section>;
}
