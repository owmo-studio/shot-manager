import { errorMessage } from '../../shared/errors';
import { useEffect, useRef, useState } from 'react';
import type { ShotCollection, VideoShot } from '../../shared/shots';

export function ClearOrganizationButton({ shots, onUpdated }: { shots: VideoShot[]; onUpdated: (collection: ShotCollection) => void }) {
    const [targets, setTargets] = useState<VideoShot[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const disabled = !shots.length || shots.some(shot => !shot.editable || !shot.fingerprint || !shot.organization);
    useEffect(() => {
        if (!targets) return;
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, [targets]);

    async function clear() {
        if (!targets || busy || disabled) return;
        setBusy(true); setError(null);
        try {
            const ids = targets.map(shot => shot.id);
            const result = await window.desktop.updateOrganization(ids, { field: 'all', operation: 'clear', value: '' });
            onUpdated(result.collection);
            window.dispatchEvent(new CustomEvent('organization-cleared', { detail: ids }));
            setTargets(null);
        } catch (error) { setError(errorMessage(error, 'Could not clear the selected clips. Please try again.')); }
        finally { setBusy(false); }
    }

    return <>
        <button type="button" aria-label="Clear selected clip information" title="Clear Identity, Project, Context and Notes"
            disabled={disabled || busy} onClick={() => { setError(null); setTargets([...shots]); }}
            className="flex h-7 items-center rounded-md border border-white/15 bg-white/8 px-2 text-[10px] font-medium text-zinc-200 transition duration-75 hover:border-red-400/40 hover:bg-red-500/15 hover:text-red-200 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40">Clear</button>
        {targets && <dialog ref={dialog} role="alertdialog" aria-labelledby="clear-organization-title" aria-describedby="clear-organization-description"
            onCancel={event => { event.preventDefault(); if (!busy) setTargets(null); }}
            className="m-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
            <h2 id="clear-organization-title" className="text-lg font-medium">Clear attributes?</h2>
            <p id="clear-organization-description" className="mt-3 text-sm leading-6 text-zinc-400">
                Attributes will be cleared for {targets.length} selected {targets.length === 1 ? 'clip' : 'clips'}.
            </p>
            {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
                <button autoFocus type="button" disabled={busy} onClick={() => setTargets(null)} className="rounded-lg border border-white/10 px-4 py-2 text-sm hover:bg-white/8 disabled:opacity-40">Cancel</button>
                <button type="button" aria-label="Confirm clear clip information" disabled={busy || disabled} onClick={() => void clear()}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40">{busy ? 'Clearing…' : 'Clear'}</button>
            </div>
        </dialog>}
    </>;
}
