import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import { ClipReviewRow } from './ClipReviewRow';
import { ModalDialog } from './ModalDialog';
import { primaryButton, secondaryButton } from './buttonStyles';

export function ReencodeDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
    const [review, setReview] = useState<Awaited<ReturnType<typeof window.desktop.reviewReencode>>>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);
    const [excluded, setExcluded] = useState<string[]>([]);
    const included = review?.clips.filter(clip => !excluded.includes(clip.id)) ?? [];
    useEffect(() => {
        let active = true;
        window.desktop.reviewReencode(ids).then(data => { if (active) setReview(data); })
            .catch(reason => { if (active) setError(errorMessage(reason, 'Could not review the selected Library clips.')); });
        return () => { active = false; };
    }, [ids]);
    async function submit() {
        if (!review || !included.length || submitting.current) return;
        submitting.current = true; setBusy(true);
        try { await window.desktop.startReencode(review.token, included.map(clip => clip.id)); onClose(); }
        catch (reason) { setReview(undefined); setError(errorMessage(reason, 'Could not queue proxy encoding.')); }
        finally { setBusy(false); }
    }
    return <ModalDialog titleId="reencode-title" title="Ready to Re-Encode Proxies?" busy={busy} onCancel={onClose}>
        {review && <p className="mt-3 text-sm text-zinc-400">{included.length} {included.length === 1 ? 'clip' : 'clips'}</p>}
        <p className="mt-2 text-sm text-zinc-500">Encode from the Library originals into the local cache. Commit the finished proxies to replace the Library copies.</p>
        {review && <div aria-label="Clips to re-encode" className="mt-4 max-h-[45vh] overflow-y-auto rounded-lg border border-white/10">
            {review.clips.map(clip => <ClipReviewRow key={clip.id} filename={clip.filename} included={!excluded.includes(clip.id)}
                busy={busy} onToggle={() => setExcluded(current => current.includes(clip.id)
                    ? current.filter(id => id !== clip.id) : [...current, clip.id])}>
                <p className="min-w-0 break-all py-1 text-sm">{clip.filename}</p>
            </ClipReviewRow>)}
        </div>}
        {!review && !error && <p className="mt-3 text-sm">Checking selected clips…</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={busy} onClick={onClose} className={secondaryButton}>{error ? 'Close' : 'Cancel'}</button>
            {review && <button disabled={busy || !included.length} onClick={() => void submit()} className={primaryButton}>
                {busy ? 'Queueing…' : 'Re-Encode'}</button>}
        </div>
    </ModalDialog>;
}
