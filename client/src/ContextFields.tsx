import { useEffect, useId, useRef, useState } from 'react';
import type { ShotCollection, VideoShot } from '../../shared/shots';
import { emptyVocabulary, normalizeOption, normalizeTag, TAG_FIELDS } from '../../shared/organization';
import type { OrganizationAction, TagField, TagVocabulary } from '../../shared/organization';

const labels: Record<TagField, string> = { identity: 'Identity', projects: 'Project', context: 'Context' };

function TagFieldInput({ field, shots, vocabulary, disabled, submit }: {
    field: TagField; shots: VideoShot[]; vocabulary: string[]; disabled: boolean;
    submit: (action: OrganizationAction) => void;
}) {
    const single = field !== 'context';
    const [query, setQuery] = useState('');
    const [focused, setFocused] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const id = useId();
    const input = useRef<HTMLInputElement>(null);
    const counts = new Map<string, number>();
    for (const shot of shots) {
        const data = shot.organization;
        const tags = field === 'identity' ? data?.identity ? [data.identity] : [] : data?.[field] ?? [];
        for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const options = vocabulary.filter(tag => tag.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())).map(tag => ({ tag, create: false }));
    if (query && !vocabulary.some(value => value.toLocaleLowerCase() === query.toLocaleLowerCase())) {
        try { options.push({ tag: single ? normalizeOption(query) : normalizeTag(query), create: true }); } catch {}
    }
    const showSuggestions = focused && !disabled;
    const active = Math.min(highlight, Math.max(0, options.length - 1));
    useEffect(() => { if (focused) input.current?.focus(); }, [focused]);
    useEffect(() => {
        if (showSuggestions) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [active, showSuggestions, id]);

    function commit(value: string, fromOption = false) {
        if (!value.trim()) return;
        try {
            const tag = single ? normalizeOption(value) : normalizeTag(value);
            const remove = !single && fromOption && counts.get(tag) === shots.length;
            submit({ field, operation: remove ? 'remove' : 'add', value: tag });
            setQuery(''); setHighlight(0); setError(null);
            if (single) setFocused(false);
        } catch (failure) { setError((failure as Error).message); }
    }
    const chips = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => {
        const partial = count !== shots.length;
        return <span key={tag} data-tag={tag} data-field={field} data-shared={!partial}
            title={partial ? `${count} of ${shots.length} selected clips` : 'Shared by all selected clips'}
            className={`inline-flex max-w-full items-center gap-1 text-zinc-300 ${single ? 'text-xs' : `rounded-md border px-2 py-1 text-[11px] ${partial ? 'border-dashed border-white/25' : 'border-white/15 bg-white/8'}`}`}>
            <span className="min-w-0 break-all">{tag}</span>
            {partial && <span className="ml-1 shrink-0 text-[10px] opacity-70">{count}/{shots.length}</span>}
            {!single && <button type="button" disabled={disabled} aria-label={`Remove ${labels[field]} tag ${tag}`}
                title="Remove from selected clips" onClick={() => submit({ field, operation: 'remove', value: tag })}
                className="ml-0.5 grid size-4 shrink-0 place-items-center rounded text-sm opacity-60 hover:bg-white/10 hover:opacity-100 disabled:opacity-30">×</button>}
        </span>;
    });
    const editor = <input ref={input} id={id} data-tag-input role="combobox" aria-label={single ? labels[field] : 'Context tags'}
        aria-expanded={showSuggestions} aria-autocomplete="list" aria-controls={`${id}-options`}
        aria-activedescendant={showSuggestions && options.length ? `${id}-option-${active}` : undefined}
        autoComplete="off" spellCheck={false} disabled={disabled} value={query}
        placeholder={single ? 'Search or add…' : shots.length ? 'Choose or add tags…' : ''} maxLength={single ? 128 : 64}
        title={single ? 'Select an existing value or type a new name; Enter saves and Tab completes.' : 'Space/Enter adds a tag; Tab completes. Use / for hierarchy.'}
        onFocus={() => setFocused(true)} onClick={() => setFocused(true)}
        onChange={event => { setQuery(single ? event.target.value.normalize('NFC') : event.target.value.normalize('NFC').toLowerCase()); setHighlight(0); setFocused(true); setError(null); }}
        onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); return; }
            if ((single ? ['Tab', 'Enter'] : ['Tab', ' ', 'Enter']).includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                const useOption = event.key === 'Tab' || (!query && event.key === 'Enter');
                commit(useOption && options.length ? options[active].tag : query, event.key === 'Enter' && !query);
            } else if (showSuggestions && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                setHighlight((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(1, options.length));
            } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFocused(false); }
        }}
        className="min-w-20 flex-1 bg-transparent px-1 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-40" />;

    return <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
        <label htmlFor={single ? `${id}-trigger` : id} className="block text-xs text-zinc-400">{labels[field]}</label>
        {single ? <div className="mt-1.5 flex min-h-10 items-center rounded-lg border border-white/10 bg-black/10 focus-within:border-blue-400/50">
            <button type="button" id={`${id}-trigger`} disabled={disabled} aria-label={`${labels[field]} selection`}
                aria-haspopup="listbox" aria-expanded={showSuggestions} aria-controls={`${id}-options`}
                onClick={() => { setQuery(''); setHighlight(0); setFocused(!focused); }}
                className="flex min-h-10 min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-white/4">
                <span className="flex min-w-0 flex-wrap gap-1.5">{chips.length ? chips : <span className="px-1 text-xs text-zinc-600">{shots.length ? 'Not assigned' : ''}</span>}</span>
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" className="size-4 shrink-0 text-zinc-500" aria-hidden="true"><path d="m5 7 5 5 5-5" strokeWidth="1.5" /></svg>
            </button>
            {counts.size > 0 && <button type="button" disabled={disabled}
                aria-label={`Clear ${labels[field]}`}
                onClick={() => { for (const tag of counts.keys()) submit({ field, operation: 'remove', value: tag }); }}
                title={`Clear ${labels[field]} from selected clips`} className="mr-2 grid size-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200">×</button>}
        </div> : <div onClick={event => { if (!(event.target instanceof Element) || !event.target.closest('button')) { setFocused(true); input.current?.focus(); } }}
            className="mt-1.5 flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-black/10 p-2 focus-within:border-blue-400/50">
            {chips}{editor}
        </div>}
        {showSuggestions && <div className="absolute top-full z-30 mt-1 w-full rounded-lg border border-white/15 bg-[#242a34] p-1 shadow-xl">
            {single && <div className="mb-1 flex border-b border-white/10 px-1 py-1">{editor}</div>}
            <ul id={`${id}-options`} role="listbox" aria-label={`${labels[field]} suggestions`} aria-multiselectable={!single}
                className="max-h-48 overflow-y-auto overscroll-contain">
                {options.map((option, index) => <li key={option.tag} id={`${id}-option-${index}`} role="option" aria-selected={counts.get(option.tag) === shots.length}>
                    <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => commit(option.tag, true)}
                        onMouseEnter={() => setHighlight(index)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-zinc-300 ${index === active ? 'bg-white/10' : 'hover:bg-white/5'}`}>
                        <span className="min-w-0 flex-1 break-all">{option.create ? `Add “${option.tag}”` : option.tag}</span>
                        {counts.get(option.tag) === shots.length ? <span aria-hidden="true" className="text-zinc-400">✓</span> : counts.has(option.tag) ? <span className="text-[10px] text-zinc-500">{counts.get(option.tag)}/{shots.length}</span> : null}
                    </button>
                </li>)}
                {!options.length && <li className="px-2 py-2 text-xs text-zinc-500">{query ? 'No matches' : single ? 'No options yet — type to add one' : 'No tags yet — type to add one'}</li>}
            </ul>
        </div>}
        {error && <p role="alert" className="mt-1 text-[11px] leading-5 text-red-300">{error}</p>}
    </div>;
}

export function ContextFields({ shots = [], onUpdated }: { shots?: VideoShot[]; onUpdated: (collection: ShotCollection) => void }) {
    const key = shots.map(shot => shot.id).sort().join(',');
    return <OrganizeFields key={key} shots={shots} onUpdated={onUpdated} />;
}

function OrganizeFields({ shots, onUpdated }: { shots: VideoShot[]; onUpdated: (collection: ShotCollection) => void }) {
    const [vocabulary, setVocabulary] = useState<TagVocabulary>(emptyVocabulary);
    const [pending, setPending] = useState(0);
    const [failure, setFailure] = useState<{ message: string; action: OrganizationAction } | null>(null);
    const mixedNotes = shots.some(shot => shot.organization?.notes !== shots[0]?.organization?.notes);
    const [notes, setNotes] = useState(mixedNotes ? '' : shots[0]?.organization?.notes ?? '');
    const mounted = useRef(true);
    const disabled = !shots.length || shots.some(shot => !shot.editable || !shot.fingerprint || !shot.organization);

    useEffect(() => {
        mounted.current = true;
        let generation = 0;
        let disposed = false;
        const reload = () => {
            const request = ++generation;
            window.desktop.getTagVocabulary().then(value => { if (!disposed && request === generation) setVocabulary(value); }).catch(() => undefined);
        };
        const cleared = (event: Event) => {
            const ids = (event as CustomEvent<string[]>).detail;
            if (shots.some(shot => ids.includes(shot.id))) setNotes('');
        };
        reload();
        window.addEventListener('organization-options-changed', reload);
        window.addEventListener('organization-cleared', cleared);
        return () => {
            disposed = true; mounted.current = false;
            void window.desktop.flushNotes().catch(() => undefined);
            window.removeEventListener('organization-options-changed', reload);
            window.removeEventListener('organization-cleared', cleared);
        };
    }, [disabled]);

    async function submit(action: OrganizationAction) {
        if (disabled) return;
        setPending(count => count + 1);
        setFailure(null);
        try {
            const result = await window.desktop.updateOrganization(shots.map(shot => shot.id), action);
            onUpdated(result.collection);
            if (mounted.current) setVocabulary(result.vocabulary);
        } catch {
            if (mounted.current) setFailure({ message: 'Could not save this change. Your saved information has been preserved.', action });
        } finally { if (mounted.current) setPending(count => count - 1); }
    }

    return <div className="space-y-4">
        <fieldset disabled={disabled} className={`space-y-4 ${disabled ? 'opacity-50' : ''}`}>
            {TAG_FIELDS.map(field => <TagFieldInput key={field} field={field} shots={shots} vocabulary={vocabulary[field]} disabled={disabled} submit={action => void submit(action)} />)}
            <label className="block text-xs text-zinc-400">Notes
                <textarea aria-label="Notes" rows={4} maxLength={10000} value={notes}
                    onBlur={() => { void window.desktop.flushNotes().catch(() => undefined); }}
                    placeholder={mixedNotes ? 'Different notes — typing replaces notes on all selected clips' : shots.length ? 'Optional notes' : ''}
                    onChange={event => { setNotes(event.target.value); void submit({ field: 'notes', operation: 'set', value: event.target.value }); }}
                    className="mt-1.5 block w-full resize-none rounded-lg border border-white/10 bg-black/10 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-blue-400/50 placeholder:text-zinc-600" />
            </label>
        </fieldset>
        {!!shots.length && disabled && <p className="text-[11px] text-zinc-500">{shots.some(shot => !shot.editable) ? 'Editing paused during rescan.' : 'Saved tags unavailable. Refresh the source to retry.'}</p>}
        {pending > 0 && <p role="status" className="text-[11px] text-zinc-500">Saving…</p>}
        {failure && <div role="alert" className="text-xs text-red-300">
            {failure.message}<button type="button" aria-label="Retry organization save" onClick={() => void submit(failure.action)} className="ml-2 underline hover:text-red-100">Retry</button>
        </div>}
    </div>;
}
