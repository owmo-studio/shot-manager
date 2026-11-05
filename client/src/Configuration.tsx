import { useEffect, useRef, useState } from 'react';
import type { AppConfiguration, LocalDataSummary } from '../../shared/desktop';
import { emptyVocabulary, TAG_FIELDS } from '../../shared/organization';
import type { TagField, TagVocabulary } from '../../shared/organization';

function cacheSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(1)} ${units[unit]}`;
}

export function Configuration() {
    const [configuration, setConfiguration] = useState<AppConfiguration | null>(null);
    const [open, setOpen] = useState(false);
    const [libraryError, setLibraryError] = useState<string | null>(null);
    const [cacheError, setCacheError] = useState<string | null>(null);
    const [cache, setCache] = useState<LocalDataSummary | null>(null);
    const [busy, setBusy] = useState<'library' | 'cache' | 'save' | null>(null);
    const [vocabulary, setVocabulary] = useState<TagVocabulary | null>(null);
    const [removals, setRemovals] = useState<TagVocabulary>(emptyVocabulary);
    const [optionsError, setOptionsError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const mutation = useRef(false);
    const requestVersion = useRef(0);
    const hasChanges = TAG_FIELDS.some(field => removals[field].length > 0);

    function showConfiguration() {
        setVocabulary(null); setRemovals(emptyVocabulary()); setOptionsError(null); setOpen(true);
    }

    useEffect(() => {
        let disposed = false;
        window.desktop.getConfiguration().then((value) => {
            if (!disposed) setConfiguration(value);
        }).catch(() => { if (!disposed) setLibraryError('Could not load configuration.'); });
        return () => { disposed = true; };
    }, []);

    useEffect(() => {
        if (!open) return;
        const element = dialog.current;
        element?.showModal();
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        async function refresh() {
            if (!mutation.current) {
                const version = requestVersion.current;
                const [usage, options] = await Promise.allSettled([window.desktop.getLocalDataSummary(), window.desktop.getTagVocabulary()]);
                if (!disposed && version === requestVersion.current) {
                    setCache(usage.status === 'fulfilled' ? usage.value : null);
                    if (options.status === 'fulfilled') { setVocabulary(options.value); setOptionsError(null); }
                    else setOptionsError('Could not load saved options.');
                }
            }
            if (!disposed) timer = setTimeout(refresh, 2000);
        }
        void refresh();
        return () => { disposed = true; clearTimeout(timer); element?.close(); };
    }, [open]);

    async function chooseLibrary() {
        if (mutation.current) return;
        mutation.current = true;
        requestVersion.current++;
        setBusy('library'); setLibraryError(null);
        try {
            const next = await window.desktop.chooseLibrary();
            if (next) setConfiguration(next);
        } catch { setLibraryError('Could not save Library location.'); }
        finally { mutation.current = false; setBusy(null); }
    }

    async function clearCache() {
        if (mutation.current) return;
        mutation.current = true;
        requestVersion.current++;
        setBusy('cache'); setCacheError(null);
        try {
            setCache(await window.desktop.clearLocalData());
            setRemovals(emptyVocabulary());
            setVocabulary(null);
            window.dispatchEvent(new Event('organization-options-changed'));
        } catch { setCacheError('Could not clear Local Data. Try again.'); }
        finally { mutation.current = false; setBusy(null); }
    }

    function removeOption(field: TagField, value: string) {
        setRemovals(current => ({ ...current, [field]: [...new Set([...current[field], value])] }));
    }

    async function saveOptions() {
        if (mutation.current || !hasChanges || !vocabulary) return;
        mutation.current = true; requestVersion.current++;
        setBusy('save'); setOptionsError(null);
        try {
            const result = await window.desktop.saveConfigurationOptions(removals);
            setVocabulary(result.vocabulary); setRemovals(emptyVocabulary());
            window.dispatchEvent(new Event('organization-options-changed'));
            setOpen(false);
        } catch { setOptionsError('Could not save the option lists. Please try again.'); }
        finally { mutation.current = false; setBusy(null); }
    }

    const buttonStyle = 'rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-200 transition hover:bg-white/10 disabled:opacity-40';
    const libraryPath = configuration?.libraryPath;
    return <>
        <div className="flex min-w-0 items-center justify-end gap-3">
            <span title={libraryPath ?? undefined}
                aria-label="Library location" className={`max-w-72 truncate px-2 py-1 text-xs ${libraryPath ? 'text-zinc-400' : 'text-red-400'}`}>
                {configuration ? libraryPath ?? 'library needs to be set' : libraryError ? 'configuration unavailable' : 'Loading configuration…'}
            </span>
            <button aria-label="Configuration" title="Configuration" onClick={showConfiguration}
                className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-5" aria-hidden="true">
                    <path strokeLinejoin="round" d="m9.5 3-.6 2.3-1.7 1L5 5.7 2.5 10l1.7 1.7v2L2.5 15.4 5 19.7l2.2-.6 1.7 1 .6 2.3h5l.6-2.3 1.7-1 2.2.6 2.5-4.3-1.7-1.7v-2l1.7-1.7L19 5.7l-2.2.6-1.7-1L14.5 3z" transform="translate(0 -1) scale(1 .96)" />
                    <circle cx="12" cy="11.5" r="3" />
                </svg>
            </button>
        </div>
        {open && <dialog ref={dialog} aria-labelledby="configuration-title"
            onCancel={(event) => { event.preventDefault(); if (!mutation.current) setOpen(false); }}
            className="m-auto max-h-[calc(100vh-48px)] w-[720px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
            <div className="flex items-center justify-between">
                <h2 id="configuration-title" className="text-lg font-medium">Configuration</h2>
                <button autoFocus disabled={!!busy} onClick={() => setOpen(false)} aria-label="Close configuration"
                    className="grid size-8 place-items-center rounded-md text-xl text-zinc-400 hover:bg-white/8 hover:text-white disabled:opacity-40">×</button>
            </div>
            <div className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-4">
                <button onClick={() => void chooseLibrary()} disabled={!!busy} className={`whitespace-nowrap ${buttonStyle}`}>
                    {busy === 'library' ? 'Choosing…' : 'Set Library location'}
                </button>
                <p aria-label="Configured Library location" role={libraryError ? 'alert' : undefined} className={`break-all select-text text-xs leading-5 ${libraryPath && !libraryError ? 'text-zinc-400' : 'text-red-400'}`}>
                    {libraryError ?? libraryPath ?? (configuration ? 'library needs to be set' : 'Loading configuration…')}
                </p>
                <button onClick={() => void clearCache()} disabled={!!busy || !cache || (cache.files === 0 && cache.options === 0)} className={`whitespace-nowrap ${buttonStyle}`}>
                    {busy === 'cache' ? 'Clearing…' : 'Clear Local Data'}
                </button>
                <span aria-label="Local Data usage" role={cacheError ? 'alert' : undefined} className={`text-xs ${cacheError ? 'text-red-400' : 'text-zinc-400'}`}>
                    {cacheError ?? (cache ? `${cacheSize(cache.bytes)} · ${cache.files.toLocaleString()} ${cache.files === 1 ? 'thumbnail' : 'thumbnails'} · ${cache.options.toLocaleString()} options` : 'Local Data unavailable')}
                </span>
            </div>
            <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/8 pt-5">
                {TAG_FIELDS.map(field => <section key={field} aria-labelledby={`options-${field}-title`}>
                    <h3 id={`options-${field}-title`} className="mb-2 text-xs font-medium text-zinc-400">{{ identity: 'Identity', projects: 'Project', context: 'Tags' }[field]}</h3>
                    <ul aria-label={`${{ identity: 'Identity', projects: 'Project', context: 'Tags' }[field]} options`}
                        className="max-h-48 min-h-24 overflow-y-auto rounded-lg border border-white/10 bg-black/10 py-1">
                        {vocabulary?.[field].filter(value => !removals[field].includes(value)).map(value => <li key={value} className="flex items-start gap-2 px-2 py-1.5 text-xs">
                            <span className="min-w-0 flex-1 break-all py-0.5 text-zinc-300">{value}</span>
                            <button type="button" aria-label={`Delete ${field === 'projects' ? 'Project' : field === 'identity' ? 'Identity' : 'Tag'} option ${value}`}
                                disabled={!!busy} onClick={() => removeOption(field, value)}
                                className="grid size-5 shrink-0 place-items-center rounded text-base text-zinc-500 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40">×</button>
                        </li>)}
                        {(!vocabulary || !vocabulary[field].some(value => !removals[field].includes(value))) && <li className="px-3 py-2 text-xs text-zinc-600">{vocabulary ? 'No entries' : 'Loading…'}</li>}
                    </ul>
                </section>)}
            </div>
            {optionsError && <p role="alert" className="mt-4 text-xs text-red-300">{optionsError}</p>}
            <div className="mt-5 flex justify-end gap-3">
                <button type="button" disabled={!!busy} onClick={() => setOpen(false)} className={buttonStyle}>Cancel</button>
                <button type="button" aria-label="Save configuration" disabled={!!busy || !hasChanges || !vocabulary}
                    onClick={() => void saveOptions()} className="rounded-md bg-blue-500 px-4 py-2 text-xs font-medium text-white hover:bg-blue-400 disabled:opacity-40">
                    {busy === 'save' ? 'Saving…' : 'Save'}
                </button>
            </div>
        </dialog>}
    </>;
}
