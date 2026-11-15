import { useState } from 'react';
import type { VideoShot } from '../../shared/shots';
import type { SyncReview } from '../../shared/sync';
import { errorMessage } from '../../shared/errors';
import { ModalDialog } from './ModalDialog';
import { primaryButton, secondaryButton, inspectorButton, inspectorDangerButton } from './buttonStyles';

const sizeLabel = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
export function DeletePlaceholder() {
    return <button disabled aria-label="Delete" title="Delete is not available yet" className={inspectorDangerButton}>
        <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
    </button>;
}
export function SyncButton({ shots }: { shots: VideoShot[] }) {
    const [selection, setSelection] = useState<VideoShot[] | null>(null);
    const [review, setReview] = useState<SyncReview | null>(null);
    const [excluded, setExcluded] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const included = review?.clips.filter(c => !excluded.includes(c.id)) ?? [];
    const blocked = included.some(c => c.issue);
    async function choose(clips: VideoShot[]) {
        setBusy(true); setError(null);
        try {
            const destination = await window.desktop.chooseSyncDestination();
            if (!destination) return;
            setReview(null);
            const prepared = await window.desktop.reviewLibrarySync(clips.map(s => s.id), destination.token);
            setSelection(clips);
            setReview(prepared);
            setExcluded([]);
        } catch (reason) { setSelection(clips); setError(errorMessage(reason, 'Could not prepare Export.')); }
        finally { setBusy(false); }
    }
    async function start() {
        if (!review || blocked || !included.length) return;
        setBusy(true); setError(null);
        try {
            try { await window.desktop.startLibrarySync(review.token, included.map(c => c.id)); }
            catch (reason) {
                const status = await window.desktop.getIngestStatus();
                if (!status.acceptedReviews?.includes(review.token)) throw reason;
            }
            setSelection(null);
        } catch (reason) { setError(errorMessage(reason, 'Could not queue Export.')); }
        finally { setBusy(false); }
    }
    const display = review?.clips ?? selection?.map(s => ({ id: s.id, filename: s.filename, issue: undefined, bytes: 0, mode: 'new' as const })) ?? [];
    return <>
        <button aria-label="Export" title="Export" className={inspectorButton} disabled={!shots.length || busy || !!selection} onClick={() => { setReview(null); setExcluded([]); void choose([...shots]); }}>
            <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></svg>
        </button>
        {selection && <ModalDialog titleId="sync-title" title="Ready to Export?" busy={busy} onCancel={() => setSelection(null)}>
            <div className="mt-4 flex items-center gap-3">
                <button disabled={busy} onClick={() => void choose(selection)} className={`${secondaryButton} shrink-0`}>{review ? 'Change Destination' : 'Choose Destination'}</button>
                {review && <p className="min-w-0 flex-1 break-all text-sm text-zinc-500">{review.destinationPath}</p>}
            </div>
            {review && <p className="mt-6 text-xs text-zinc-400">{included.length} {included.length === 1 ? 'clip' : 'clips'} · {sizeLabel(included.reduce((sum, c) => sum + c.bytes, 0))}</p>}
            <div aria-label="Export clips" className="mt-4 max-h-[40vh] overflow-auto rounded-lg border border-white/10">
                {display.map(clip => { const removed = excluded.includes(clip.id); return <div key={clip.id} data-sync-included={!removed} className="flex items-start gap-3 border-b border-white/8 p-3 last:border-0">
                    <div className={`min-w-0 flex-1 ${removed ? 'opacity-40' : ''}`}>
                        <div className="flex min-h-7 items-center gap-3">
                            <span className={`min-w-16 shrink-0 rounded px-2 py-0.5 text-center text-xs ${review ? 'bg-blue-400/10 text-blue-300' : 'bg-white/5 text-zinc-500'}`}>
                                {review ? clip.mode === 'replace' ? 'Update' : 'New' : 'Pending'}
                            </span>
                            <p className="min-w-0 break-all text-sm" title={'outputFilename' in clip ? clip.outputFilename : undefined}>{clip.filename}</p>
                        </div>
                        {clip.issue && <p className="mt-1 text-xs text-amber-300">{clip.issue}</p>}
                    </div>
                    <button disabled={busy} aria-label={`${removed ? 'Restore' : 'Remove'} ${clip.filename} ${removed ? 'to' : 'from'} Export`} aria-pressed={removed}
                        onClick={() => setExcluded(current => removed ? current.filter(id => id !== clip.id) : [...current, clip.id])}
                        className="grid size-7 shrink-0 place-items-center rounded text-2xl text-zinc-400 hover:bg-white/8 hover:text-white focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40">{removed ? '−' : '×'}</button>
                </div>; })}
            </div>
            {included.some(c => c.mode === 'replace') && <p className="mt-3 text-xs text-zinc-500">Existing files marked Update will be replaced.</p>}
            {blocked && <p className="mt-3 text-xs text-zinc-400">Exclude clips that need attention, or cancel to resolve them.</p>}
            {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
            <div className="mt-5 flex justify-end gap-3">
                <button autoFocus className={secondaryButton} disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
                <button className={primaryButton} disabled={busy || !review || !included.length || blocked} onClick={() => void start()}>{busy ? 'Preparing…' : 'Export'}</button>
            </div>
        </ModalDialog>}
    </>;
}
