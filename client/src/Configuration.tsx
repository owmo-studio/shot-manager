import { useEffect, useRef, useState } from 'react';
import type { AppConfiguration, CacheSummary } from '../../shared/desktop';

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
    const [cache, setCache] = useState<CacheSummary | null>(null);
    const [busy, setBusy] = useState<'library' | 'cache' | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const mutation = useRef(false);

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
                try {
                    const value = await window.desktop.getCacheSummary();
                    if (!disposed) setCache(value);
                } catch { if (!disposed) setCache(null); }
            }
            if (!disposed) timer = setTimeout(refresh, 2000);
        }
        void refresh();
        return () => { disposed = true; clearTimeout(timer); element?.close(); };
    }, [open]);

    async function chooseLibrary() {
        if (mutation.current) return;
        mutation.current = true;
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
        setBusy('cache'); setCacheError(null);
        try {
            setCache(await window.desktop.clearCache());
        } catch { setCacheError('Could not clear cache. Try again.'); }
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
            <button aria-label="Configuration" title="Configuration" onClick={() => setOpen(true)}
                className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-5" aria-hidden="true">
                    <path strokeLinejoin="round" d="m9.5 3-.6 2.3-1.7 1L5 5.7 2.5 10l1.7 1.7v2L2.5 15.4 5 19.7l2.2-.6 1.7 1 .6 2.3h5l.6-2.3 1.7-1 2.2.6 2.5-4.3-1.7-1.7v-2l1.7-1.7L19 5.7l-2.2.6-1.7-1L14.5 3z" transform="translate(0 -1) scale(1 .96)" />
                    <circle cx="12" cy="11.5" r="3" />
                </svg>
            </button>
        </div>
        {open && <dialog ref={dialog} aria-labelledby="configuration-title"
            onCancel={(event) => { event.preventDefault(); if (!mutation.current) setOpen(false); }}
            className="m-auto w-[560px] max-w-[calc(100vw-48px)] rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
            <div className="flex items-center justify-between">
                <h2 id="configuration-title" className="text-lg font-medium">Configuration</h2>
                <button autoFocus disabled={!!busy} onClick={() => setOpen(false)} aria-label="Close configuration"
                    className="grid size-8 place-items-center rounded-md text-xl text-zinc-400 hover:bg-white/8 hover:text-white disabled:opacity-40">×</button>
            </div>
            <section className="mt-6" aria-labelledby="library-setting-title">
                <h3 id="library-setting-title" className="text-sm font-medium">Library location</h3>
                <p role={libraryError ? 'alert' : undefined} className={`mt-2 break-all select-text text-xs leading-5 ${libraryPath && !libraryError ? 'text-zinc-400' : 'text-red-400'}`}>
                    {libraryError ?? libraryPath ?? (configuration ? 'library needs to be set' : 'Loading configuration…')}
                </p>
                <button onClick={() => void chooseLibrary()} disabled={!!busy} className={`mt-3 ${buttonStyle}`}>
                    {busy === 'library' ? 'Choosing…' : 'Set Library location'}
                </button>
            </section>
            <section className="mt-6 border-t border-white/8 pt-5" aria-labelledby="cache-setting-title">
                <h3 id="cache-setting-title" className="text-sm font-medium">Local cache</h3>
                <div className="mt-3 flex items-center gap-4">
                    <button onClick={() => void clearCache()} disabled={!!busy || !cache || cache.files === 0} className={buttonStyle}>
                        {busy === 'cache' ? 'Clearing…' : 'Clear local cache'}
                    </button>
                    <span aria-label="Cache usage" role={cacheError ? 'alert' : undefined} className={`text-xs ${cacheError ? 'text-red-400' : 'text-zinc-400'}`}>
                        {cacheError ?? (cache ? `${cacheSize(cache.bytes)} · ${cache.files.toLocaleString()} ${cache.files === 1 ? 'file' : 'files'}` : 'Cache unavailable')}
                    </span>
                </div>
            </section>
        </dialog>}
    </>;
}
