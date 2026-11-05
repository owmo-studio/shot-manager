import { errorMessage } from '../../shared/errors';
import { useEffect, useRef, useState } from 'react';
import type { LocalDataSummary } from '../../shared/desktop';
import type { ShotCollection } from '../../shared/shots';

export function ResetLocalDataButton({ disabled, onBusyChange, onReset }: {
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
    onReset: (collection: ShotCollection) => void;
}) {
    const [open, setOpen] = useState(false);
    const [summary, setSummary] = useState<LocalDataSummary | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const mutation = useRef(false);

    useEffect(() => {
        if (!open) return;
        const element = dialog.current;
        element?.showModal();
        let disposed = false;
        window.desktop.getLocalDataSummary().then(value => {
            if (!disposed) setSummary(value);
        }).catch(() => { if (!disposed) setError('Could not load local data totals. Close and try again.'); });
        return () => { disposed = true; element?.close(); };
    }, [open]);

    function close() {
        if (mutation.current) return;
        setOpen(false);
        onBusyChange(false);
    }

    async function reset() {
        if (mutation.current || !summary) return;
        mutation.current = true; setBusy(true); setError(null);
        try {
            const result = await window.desktop.clearLocalData();
            setOpen(false);
            onReset(result.collection);
        } catch (error) {
            setError(errorMessage(error, 'Reset could not finish. Some local data may already have been cleared. Try again.'));
        } finally { mutation.current = false; setBusy(false); }
    }

    return <>
        <button type="button" disabled={disabled} onClick={() => {
            setSummary(null); setError(null); setOpen(true); onBusyChange(true);
        }} className="mr-auto rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 transition hover:bg-red-500/20 hover:text-red-200 disabled:opacity-40">Reset Local Data</button>
        {open && <dialog ref={dialog} role="alertdialog" aria-labelledby="reset-local-data-title" aria-describedby="reset-local-data-description"
            onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
            className="m-auto max-h-[calc(100vh-48px)] w-[480px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
            <h2 id="reset-local-data-title" className="text-lg font-medium">Reset all local data?</h2>
            <p id="reset-local-data-description" className="mt-3 text-sm leading-6 text-zinc-300">Local data will be permanently deleted.</p>
            {summary ? <ul aria-label="Local data to reset" className="mt-3 space-y-2 text-sm text-zinc-400">
                <li>{summary.files.toLocaleString()} thumbnails · {(summary.bytes / 1024 / 1024).toFixed(1)} MB</li>
                <li>{summary.identities.toLocaleString()} identities · {summary.projects.toLocaleString()} projects</li>
                <li>{summary.records.toLocaleString()} clip records</li>
                <li>{summary.fingerprints.toLocaleString()} fingerprints</li>
                <li>{summary.sources.toLocaleString()} sources · {summary.clips.toLocaleString()} workspace clips</li>
            </ul> : <p className="mt-3 text-sm text-zinc-500">Loading totals…</p>}
            <p className="mt-4 text-xs text-zinc-500">Preserved: source videos, Library files, settings.</p>
            {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
                <button autoFocus type="button" disabled={busy} onClick={close} className="rounded-md border border-white/10 px-3 py-2 text-xs hover:bg-white/8 disabled:opacity-40">Cancel</button>
                <button type="button" aria-label="Confirm reset local data" disabled={busy || !summary} onClick={() => void reset()}
                    className="rounded-md bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-40">{busy ? 'Resetting…' : 'Reset Local Data'}</button>
            </div>
        </dialog>}
    </>;
}
