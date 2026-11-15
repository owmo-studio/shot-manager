import { useEffect, useState } from 'react';
import type { VideoShot } from '../../shared/shots';
import type { LibraryDeleteReview } from '../../shared/library';
import { errorMessage } from '../../shared/errors';
import { dangerButton, inspectorDangerButton, secondaryButton } from './buttonStyles';
import { ModalDialog } from './ModalDialog';
import { ErrorDialog } from './ErrorDialog';

export function DeleteButton({ shots, onClick }: { shots: VideoShot[]; onClick: () => void }) {
    return <button type="button" aria-label="Delete" title="Delete from Library" disabled={!shots.length || shots.some(shot => !shot.editable)} onClick={onClick} className={inspectorDangerButton}>
        <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
    </button>;
}

// Lives above the inspector so completion/selection changes cannot dismiss errors.
export function LibraryDeleteDialog({ shots, onClose }: { shots: VideoShot[]; onClose: () => void }) {
    const [review, setReview] = useState<LibraryDeleteReview | null>(null);
    const [checking, setChecking] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [finishedError, setFinishedError] = useState<string | null>(null);
    const [excluded, setExcluded] = useState<string[]>([]);
    const clips = review?.clips ?? shots;
    const included = clips.filter(clip => !excluded.includes(clip.id));
    useEffect(() => {
        let cancelled = false;
        window.desktop.reviewLibraryDelete(shots.map(shot => shot.id)).then(value => {
            if (!cancelled) setReview(value);
        }).catch(reason => {
            if (!cancelled) setError(errorMessage(reason, 'Could not prepare Delete.'));
        }).finally(() => { if (!cancelled) setChecking(false); });
        return () => { cancelled = true; };
    }, [shots]);
    async function confirm() {
        if (!review || busy || !included.length) return;
        setBusy(true); setError(null);
        try {
            const result = await window.desktop.deleteLibraryClips(review.token, included.map(clip => clip.id));
            if (result.errors.length) setFinishedError([
                result.deleted.length ? `${result.deleted.length} ${result.deleted.length === 1 ? 'clip' : 'clips'} deleted.` : '',
                ...result.errors.map(entry => `${entry.filename}: ${entry.message}`),
            ].filter(Boolean).join('\n'));
            else onClose();
        } catch (reason) {
            setError(errorMessage(reason, 'Could not delete clips.'));
            setReview(null); // Stale or failed reviews require a fresh confirmation.
        } finally { setBusy(false); }
    }
    if (finishedError) return <ErrorDialog title="Delete error" message={finishedError} onDismiss={onClose} />;
    return <ModalDialog titleId="delete-title" title="Ready to Delete?" busy={busy} onCancel={onClose}>
        <p className="mt-3 text-sm text-zinc-400">{included.length} {included.length === 1 ? 'clip' : 'clips'}</p>
        <p className="mt-2 text-sm text-zinc-500">Delete all associated Library files and their local metadata.</p>
        <div aria-label="Affected clips" className="mt-4 max-h-[45vh] overflow-y-auto rounded-lg border border-white/10">
            {clips.map(clip => {
                const removed = excluded.includes(clip.id);
                return <div key={clip.id} data-delete-included={!removed}
                    className={`flex items-start gap-3 border-b border-white/8 p-3 last:border-0 ${removed ? 'bg-white/[0.02]' : ''}`}>
                    <div className={`flex min-h-7 min-w-0 flex-1 items-center gap-3 ${removed ? 'opacity-40' : ''}`}>
                        <span className="min-w-16 shrink-0 rounded bg-red-400/10 px-2 py-0.5 text-center text-xs text-red-300">Delete</span>
                        <p className="min-w-0 break-all text-sm">{clip.filename}</p>
                    </div>
                    <button disabled={busy} aria-label={`${removed ? 'Restore' : 'Remove'} ${clip.filename} ${removed ? 'to' : 'from'} Delete`} aria-pressed={removed}
                        onClick={() => setExcluded(current => removed ? current.filter(id => id !== clip.id) : [...current, clip.id])}
                        className="grid size-7 shrink-0 place-items-center rounded text-2xl leading-none text-zinc-400 hover:bg-white/8 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40">{removed ? '−' : '×'}</button>
                </div>;
            })}
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={busy} onClick={onClose} className={secondaryButton}>Cancel</button>
            <button aria-label="Confirm delete clips" disabled={checking || busy || !review || !included.length} onClick={() => void confirm()} className={dangerButton}>{busy ? 'Deleting…' : checking ? 'Checking…' : 'Delete'}</button>
        </div>
    </ModalDialog>;
}
