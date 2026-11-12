import { errorMessage } from '../../shared/errors';
import { useEffect, useId, useRef, useState } from 'react';
import type { ShotCollection, VideoShot } from '../../shared/shots';
import { emptyVocabulary, normalizeOption, normalizeScene, normalizeTag, SCENE_MAX_LENGTH } from '../../shared/organization';
import type { OrganizationAction, TagField, TagVocabulary } from '../../shared/organization';
import { ClearOrganizationButton } from './ClearOrganizationButton';
import { RevertOrganizationButton } from './RevertOrganizationButton';

const labels: Record<TagField, string> = { identity: 'Identity', project: 'Project', tags: 'Tags' };

function TagFieldInput({ field, shots, vocabulary, disabled, submit }: {
    field: TagField; shots: VideoShot[]; vocabulary: string[]; disabled: boolean;
    submit: (action: OrganizationAction) => void;
}) {
    const single = field !== 'tags';
    const [query, setQuery] = useState('');
    const [focused, setFocused] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const [optionChosen, setOptionChosen] = useState(false);
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const id = useId();
    const input = useRef<HTMLInputElement>(null);
    const counts = new Map<string, number>();
    for (const shot of shots) {
        const data = shot.organization;
        const tags = single ? data?.[field] ? [data[field]] : [] : data?.tags ?? [];
        for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const options = vocabulary.filter(tag => tag.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())).map(tag => ({ tag, create: false }));
    if (query && !vocabulary.some(value => value.toLocaleLowerCase() === query.toLocaleLowerCase())) {
        try { options.push({ tag: single ? normalizeOption(query) : normalizeTag(query), create: true }); } catch {}
    }
    const showSuggestions = focused && !disabled && (single || query.length > 0);
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
            setSelectedTag(null);
            setQuery(''); setHighlight(0); setOptionChosen(false); setError(null);
            if (single) setFocused(false);
        } catch (failure) { setError((failure as Error).message); }
    }
    const chips = [...counts].map(([tag, count]) => {
        const partial = count !== shots.length;
        return <span key={tag} data-tag={tag} data-field={field} data-shared={!partial} data-tag-selected={selectedTag === tag && focused && !disabled}
            title={partial ? `${count} of ${shots.length} selected clips` : 'Shared by all selected clips'}
            className={`inline-flex max-w-full items-center gap-1 text-zinc-300 ${single ? 'text-xs' : `rounded-md border px-2 py-1 text-[11px] ${partial ? 'border-dashed border-white/25' : 'border-white/15 bg-white/8'} ${selectedTag === tag && focused && !disabled ? 'ring-1 ring-blue-300 bg-blue-400/15 text-blue-100' : ''}`}`}>
            <span className={single ? 'min-w-0 truncate' : 'min-w-0 break-all'} title={tag}>{tag}</span>
            {partial && <span className="ml-1 shrink-0 text-[10px] opacity-70">{count}/{shots.length}</span>}
            {!single && <button type="button" disabled={disabled} aria-label={`Remove tag ${tag}`}
                title="Remove from selected clips" onClick={() => { setSelectedTag(null); submit({ field, operation: 'remove', value: tag }); }}
                className="ml-0.5 grid size-4 shrink-0 place-items-center rounded text-sm opacity-60 hover:bg-white/10 hover:opacity-100 disabled:opacity-30">×</button>}
        </span>;
    });
    const editor = <input ref={input} id={id} data-tag-input role="combobox" aria-label={labels[field]}
        aria-expanded={showSuggestions} aria-autocomplete="list" aria-controls={`${id}-options`}
        aria-activedescendant={showSuggestions && options.length ? `${id}-option-${active}` : undefined}
        autoComplete="off" spellCheck={false} disabled={disabled} value={query}
        placeholder={single ? 'Search or add…' : shots.length ? 'Choose or add tags…' : ''} maxLength={single ? 128 : 64}
        title={single ? 'Select an existing value or type a new name; Enter saves and Tab completes.' : 'Space/Enter adds a tag; Tab completes. Use / for hierarchy.'}
        onFocus={() => setFocused(true)} onClick={() => { setSelectedTag(null); setFocused(true); }}
        onChange={event => { setSelectedTag(null); setQuery(single ? event.target.value.normalize('NFC') : event.target.value.normalize('NFC').toLowerCase()); setHighlight(0); setOptionChosen(false); setFocused(true); setError(null); }}
        onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (!single && event.key === 'Backspace' && !query && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault(); event.stopPropagation();
                if (event.repeat || disabled) return;
                if (selectedTag && counts.has(selectedTag)) {
                    submit({ field, operation: 'remove', value: selectedTag });
                    setSelectedTag(null);
                } else setSelectedTag([...counts.keys()].at(-1) ?? null);
                return;
            }
            if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); return; }
            if ((single ? ['Tab', 'Enter'] : ['Tab', ' ', 'Enter']).includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                if (!single && !query) return;
                const useOption = event.key === 'Tab' || (event.key === 'Enter' && showSuggestions && (optionChosen || !query));
                commit(useOption && options.length ? options[active].tag : query, event.key === 'Enter' && !query);
            } else if (showSuggestions && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                setOptionChosen(true);
                setHighlight((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(1, options.length));
            } else if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation();
                if (selectedTag) setSelectedTag(null);
                else setFocused(false);
            }
        }}
        className={`min-w-20 flex-1 bg-transparent px-1 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-40 ${selectedTag ? 'caret-transparent' : ''}`} />;

    return <div data-attribute-field={field} className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setFocused(false); setSelectedTag(null); } }}>
        <label htmlFor={single ? `${id}-trigger` : id} className="attribute-label block text-xs text-zinc-400">{labels[field]}</label>
        {single ? <div className="tag-control mt-1.5 flex min-h-10 items-center rounded-lg border border-white/10 bg-black/10 focus-within:border-blue-400/50">
            <button type="button" id={`${id}-trigger`} disabled={disabled} aria-label={`${labels[field]} selection`}
                aria-haspopup="listbox" aria-expanded={showSuggestions} aria-controls={`${id}-options`}
                onClick={() => { setQuery(''); setHighlight(0); setOptionChosen(false); setFocused(!focused); }}
                className="flex min-h-10 min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-white/4">
                <span className="option-chips flex max-h-14 min-w-0 flex-wrap gap-1.5 overflow-y-auto">{chips.length ? chips : <span className="px-1 text-xs text-zinc-600">{shots.length ? 'Not assigned' : ''}</span>}</span>
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" className="size-4 shrink-0 text-zinc-500" aria-hidden="true"><path d="m5 7 5 5 5-5" strokeWidth="1.5" /></svg>
            </button>
            {counts.size > 0 && <button type="button" disabled={disabled}
                aria-label={`Clear ${labels[field]}`}
                onClick={() => { for (const tag of counts.keys()) submit({ field, operation: 'remove', value: tag }); }}
                title={`Clear ${labels[field]} from selected clips`} className="mr-2 grid size-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200">×</button>}
        </div> : <div onClick={event => { if (!(event.target instanceof Element) || !event.target.closest('button')) { setSelectedTag(null); setFocused(true); input.current?.focus(); } }}
            className="tag-control mt-1.5 flex max-h-16 min-h-10 cursor-text flex-wrap items-center gap-1.5 overflow-y-auto rounded-lg border border-white/10 bg-black/10 p-2 focus-within:border-blue-400/50">
            {chips}{editor}
        </div>}
        {showSuggestions && <div className="absolute top-full z-30 mt-1 w-full rounded-lg border border-white/15 bg-[#242a34] p-1 shadow-xl">
            {single && <div className="mb-1 flex border-b border-white/10 px-1 py-1">{editor}</div>}
            <ul id={`${id}-options`} role="listbox" aria-label={`${field === 'tags' ? 'Tag' : labels[field]} suggestions`} aria-multiselectable={!single}
                className="max-h-48 overflow-y-auto overscroll-contain">
                {options.map((option, index) => <li key={option.tag} id={`${id}-option-${index}`} role="option" aria-selected={counts.get(option.tag) === shots.length}>
                    <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => commit(option.tag, true)}
                        onMouseEnter={() => { setHighlight(index); setOptionChosen(true); }}
                        className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-zinc-300 ${index === active ? 'bg-white/10' : 'hover:bg-white/5'}`}>
                        <span className="min-w-0 flex-1 break-all">{option.create ? `Add “${option.tag}”` : option.tag}</span>
                        {counts.get(option.tag) === shots.length ? <span aria-hidden="true" className="text-zinc-400">✓</span> : counts.has(option.tag) ? <span className="text-[10px] text-zinc-500">{counts.get(option.tag)}/{shots.length}</span> : null}
                    </button>
                </li>)}
                {!options.length && <li className="px-2 py-2 text-xs text-zinc-500">{query ? 'No matches' : single ? 'No options yet — type to add one' : 'No tags yet — type to add one'}</li>}
            </ul>
        </div>}
        {selectedTag && focused && !disabled && counts.has(selectedTag) && <span role="status" className="sr-only">{selectedTag} selected. Press Backspace to remove or Escape to cancel.</span>}
        {error && <p role="alert" className="mt-1 text-[11px] leading-5 text-red-300">{error}</p>}
    </div>;
}

export function AttributeFields({ shots = [], onUpdated }: { shots?: VideoShot[]; onUpdated: (collection: ShotCollection) => void }) {
    const key = shots.map(shot => shot.id).sort().join(',');
    return <AttributeEditor key={key} shots={shots} onUpdated={onUpdated} />;
}

function AttributeEditor({ shots, onUpdated }: { shots: VideoShot[]; onUpdated: (collection: ShotCollection) => void }) {
    const [vocabulary, setVocabulary] = useState<TagVocabulary>(emptyVocabulary);
    const [pending, setPending] = useState(0);
    const [failure, setFailure] = useState<string | null>(null);
    const mixedNotes = shots.some(shot => shot.organization?.notes !== shots[0]?.organization?.notes);
    const [notes, setNotes] = useState(mixedNotes ? '' : shots[0]?.organization?.notes ?? '');
    const mixedScene = shots.some(shot => shot.organization?.scene !== shots[0]?.organization?.scene);
    const [scene, setScene] = useState(mixedScene ? '' : shots[0]?.organization?.scene ?? '');
    const [sceneError, setSceneError] = useState<string | null>(null);
    const sceneHintId = useId();
    const mounted = useRef(true);
    const textGeneration = useRef(0);
    const pendingText = useRef(0);
    const disabled = !shots.length || shots.some(shot => !shot.editable || !shot.fingerprint || !shot.organization);

    async function refreshRetriedText() {
        const generation = textGeneration.current;
        const collection = await window.desktop.getShots();
        onUpdated(collection);
        if (!mounted.current || generation !== textGeneration.current || pendingText.current) return;
        const drafts = shots.map(shot => collection.shots.find(current => current.id === shot.id)?.organization);
        if (drafts.some(draft => !draft)) return;
        setScene(drafts.every(draft => draft!.scene === drafts[0]!.scene) ? drafts[0]?.scene ?? '' : '');
        setNotes(drafts.every(draft => draft!.notes === drafts[0]!.notes) ? drafts[0]?.notes ?? '' : '');
    }

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
            if (shots.some(shot => ids.includes(shot.id))) { textGeneration.current++; setNotes(''); setScene(''); setSceneError(null); }
            reload();
        };
        const retried = () => { setFailure(null); reload(); void refreshRetriedText().catch(() => undefined); };
        reload();
        let vocabularyRevision = -1;
        const unsubscribe = window.desktop.onShotsChanged(change => {
            if (change.vocabularyRevision === vocabularyRevision) return;
            vocabularyRevision = change.vocabularyRevision;
            reload();
        });
        window.addEventListener('organization-options-changed', reload);
        window.addEventListener('organization-cleared', cleared);
        window.addEventListener('organization-saves-retried', retried);
        return () => {
            disposed = true; mounted.current = false;
            unsubscribe();
            void window.desktop.flushOrganizationText().catch(() => undefined);
            window.removeEventListener('organization-options-changed', reload);
            window.removeEventListener('organization-cleared', cleared);
            window.removeEventListener('organization-saves-retried', retried);
        };
    }, [disabled]);

    async function submit(action: OrganizationAction) {
        if (disabled) return;
        const text = action.field === 'scene' || action.field === 'notes';
        if (text) { textGeneration.current++; pendingText.current++; }
        setPending(count => count + 1);
        setFailure(null);
        try {
            const result = await window.desktop.updateOrganization(shots.map(shot => shot.id), action);
            onUpdated(result.collection);
            if (mounted.current) setVocabulary(result.vocabulary);
        } catch (error) {
            if (mounted.current) setFailure(errorMessage(error, 'Could not save this change. Your saved information has been preserved.'));
        } finally {
            if (text) pendingText.current--;
            if (mounted.current) setPending(count => count - 1);
        }
    }

    return <div className="attribute-fields flex flex-1 flex-col gap-2">
        <fieldset disabled={disabled} className={`flex min-w-0 flex-col gap-3 ${disabled ? 'opacity-50' : ''}`}>
            {(['identity', 'project'] as const).map(field => <TagFieldInput key={field} field={field} shots={shots} vocabulary={vocabulary[field]} disabled={disabled} submit={action => void submit(action)} />)}
            <label data-attribute-field="scene" className="block text-xs text-zinc-400">
                <span className="attribute-label flex items-center justify-between gap-1">Scene <span className="text-[10px] text-zinc-600">{scene.length}/{SCENE_MAX_LENGTH}</span></span>
                <input aria-label="Scene" type="text" autoComplete="off" maxLength={SCENE_MAX_LENGTH} value={scene}
                    aria-describedby={sceneHintId} aria-invalid={!!sceneError}
                    title="A short sentence. Letters, numbers, spaces, apostrophes, commas, periods, and hyphens."
                    placeholder={mixedScene ? 'Mixed scenes — typing replaces selected values' : shots.length ? 'Describe the shot…' : ''}
                    onBlur={() => { setScene(normalizeScene(scene)); setSceneError(null); void window.desktop.flushOrganizationText().catch(() => undefined); }}
                    onChange={event => {
                        const value = event.target.value.normalize('NFC').replace(/[‘’]/g, "'").replace(/[–—]/g, '-');
                        try {
                            const normalized = normalizeScene(value);
                            setScene(value); setSceneError(null);
                            void submit({ field: 'scene', operation: 'set', value: normalized });
                        } catch (error) { setSceneError((error as Error).message); }
                    }}
                    className="mt-1.5 block h-9 w-full min-w-0 rounded-lg border border-white/10 bg-black/10 px-3 text-xs text-zinc-200 outline-none focus:border-blue-400/50 placeholder:text-zinc-600" />
                <span id={sceneHintId} className={sceneError ? 'mt-1 block text-[11px] text-red-300' : 'sr-only'} role={sceneError ? 'alert' : undefined}>
                    {sceneError ?? 'Up to 80 characters. Letters, numbers, spaces, apostrophes, commas, periods, and hyphens.'}
                </span>
            </label>
            <label data-attribute-field="notes" className="block text-xs text-zinc-400"><span className="attribute-label">Notes</span>
                <textarea aria-label="Notes" rows={6} maxLength={10000} value={notes}
                    onBlur={() => { void window.desktop.flushOrganizationText().catch(() => undefined); }}
                    placeholder={mixedNotes ? 'Mixed notes — typing replaces selected values' : shots.length ? 'Optional notes' : ''}
                    onChange={event => { setNotes(event.target.value); void submit({ field: 'notes', operation: 'set', value: event.target.value }); }}
                    className="mt-1.5 block w-full resize-none rounded-lg border border-white/10 bg-black/10 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-blue-400/50 placeholder:text-zinc-600" />
            </label>
            <TagFieldInput field="tags" shots={shots} vocabulary={vocabulary.tags} disabled={disabled} submit={action => void submit(action)} />
        </fieldset>
        {!!shots.length && disabled && !shots.some(shot => !shot.editable) && <p className="text-[11px] text-zinc-500">Saved attributes unavailable. Add the clips again to retry.</p>}
        {failure && <div role="alert" className="text-xs text-red-300">
            {failure}<button type="button" aria-label="Retry organization save" onClick={async () => {
                try {
                    await window.desktop.retryOrganizationSaves();
                    await refreshRetriedText();
                    setVocabulary(await window.desktop.getTagVocabulary());
                    setFailure(null);
                } catch { /* Both the inspector and app-level banner keep the failure visible. */ }
            }} className="ml-2 underline hover:text-red-100">Retry</button>
        </div>}
        <div className="attribute-clear mt-auto flex items-center justify-between gap-3 pt-3">
            <div className="flex items-center gap-2">
                <ClearOrganizationButton shots={shots} onUpdated={onUpdated} />
                <RevertOrganizationButton shots={shots} onReverted={result => {
                    textGeneration.current++;
                    const drafts = shots.map(shot => result.collection.shots.find(current => current.id === shot.id)?.organization);
                    setNotes(drafts.every(draft => draft?.notes === drafts[0]?.notes) ? drafts[0]?.notes ?? '' : '');
                    setScene(drafts.every(draft => draft?.scene === drafts[0]?.scene) ? drafts[0]?.scene ?? '' : '');
                    setSceneError(null); setFailure(null); setVocabulary(result.vocabulary);
                    onUpdated(result.collection);
                }} />
            </div>
            {pending > 0 && <p role="status" className="text-right text-[11px] text-zinc-500">Saving…</p>}
        </div>
    </div>;
}
