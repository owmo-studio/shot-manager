import { useEffect, useId, useState } from 'react';

// Selection-only counterpart to the inspector's searchable attribute dropdown.
export function FilterDropdown({ label, options, selected, onToggle }: {
    label: string; options: [string, number][]; selected: string[]; onToggle: (value: string) => void;
}) {
    const id = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [highlight, setHighlight] = useState(0);
    const available = options.filter(([, count]) => count > 0);
    const disabled = available.length <= 1;
    useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
    const matches = options.filter(([name]) => name.toLowerCase().includes(query.normalize('NFC').toLowerCase()));
    const active = Math.min(highlight, Math.max(0, matches.length - 1));
    useEffect(() => {
        if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [open, active, id]);
    return <div className="space-y-2">
        <h2 className="text-xs text-zinc-400">{label}</h2>
        <div className="relative" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}>
            <button type="button" id={`${id}-trigger`} aria-label={`Choose filter ${label.toLowerCase()}`} aria-haspopup="listbox"
                disabled={disabled} aria-expanded={open && !disabled} aria-controls={`${id}-options`}
                onClick={() => { setQuery(''); setHighlight(0); setOpen(!open); }}
                className="flex min-h-10 w-full items-center justify-between rounded-lg border border-white/10 bg-black/10 px-3 text-xs text-zinc-400 enabled:hover:bg-white/4 focus-visible:outline-blue-400 disabled:opacity-40 disabled:cursor-not-allowed">
                <span className="min-w-0 truncate" title={available.length === 1 ? available[0][0] : undefined}>
                    {available.length === 1 ? available[0][0] : `Choose ${label.toLowerCase()}…`}
                </span><span aria-hidden="true">⌄</span>
            </button>
            {open && !disabled && <div className="absolute top-full z-30 mt-1 w-full rounded-lg border border-white/15 bg-[#242a34] p-1 shadow-xl">
                <input autoFocus data-tag-input role="combobox" aria-label={`Find filter ${label.toLowerCase()}`}
                    aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list"
                    aria-activedescendant={matches.length ? `${id}-${active}` : undefined}
                    placeholder="Search…" value={query} autoComplete="off"
                    className="mb-1 w-full border-b border-white/10 bg-transparent px-2 py-2 text-xs outline-none placeholder:text-zinc-600"
                    onChange={event => { setQuery(event.target.value); setHighlight(0); }}
                    onKeyDown={event => {
                        if (event.nativeEvent.isComposing) return;
                        if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) {
                            event.preventDefault(); event.stopPropagation();
                            if (event.key === 'Escape') { setOpen(false); document.getElementById(`${id}-trigger`)?.focus(); }
                            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setHighlight((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length));
                            else if (matches[active]) onToggle(matches[active][0]);
                        }
                    }} />
                <ul id={`${id}-options`} role="listbox" aria-label={`${label} filter options`} aria-multiselectable="true"
                    className="max-h-48 overflow-y-auto overscroll-contain">
                    {matches.map(([name], index) => <li key={name} id={`${id}-${index}`} role="option" aria-selected={selected.includes(name)}>
                        <button type="button" aria-label={`Filter by ${label.toLowerCase()}: ${name}`}
                            onMouseDown={event => event.preventDefault()} onClick={() => onToggle(name)} onMouseEnter={() => setHighlight(index)}
                            className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs ${active === index ? 'bg-white/10' : 'hover:bg-white/5'}`}>
                            <span aria-hidden="true" className="grid size-3.5 shrink-0 place-items-center rounded-sm border border-zinc-500">{selected.includes(name) ? '✓' : ''}</span>
                            <span className="min-w-0 flex-1 break-all">{name}</span>
                        </button>
                    </li>)}
                    {!matches.length && <li className="px-2 py-2 text-xs text-zinc-500">No matches</li>}
                </ul>
            </div>}
        </div>
        {!!selected.length && <ul className="space-y-0.5" aria-label={`Selected filter ${label.toLowerCase()}`}>
            {selected.map(name => <li key={name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-300 hover:bg-white/5">
                <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
                <button type="button" aria-label={`Remove ${label.toLowerCase()} filter ${name}`} onClick={() => onToggle(name)}
                    className="grid size-4 shrink-0 place-items-center rounded text-sm opacity-60 hover:bg-white/10 hover:opacity-100">×</button>
            </li>)}
        </ul>}
    </div>;
}
