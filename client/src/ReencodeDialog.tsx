import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import { ModalDialog } from './ModalDialog';
import { primaryButton, secondaryButton } from './buttonStyles';

export function ReencodeDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
    const [review, setReview] = useState<Awaited<ReturnType<typeof window.desktop.reviewReencode>>>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);
    useEffect(() => {
        let active = true;
        window.desktop.reviewReencode(ids).then(data => { if (active) setReview(data); })
            .catch(reason => { if (active) setError(errorMessage(reason, 'Could not review the selected Library clips.')); });
        return () => { active = false; };
    }, [ids]);
    async function submit() {
        if (!review || submitting.current) return;
        submitting.current = true; setBusy(true);
        try { await window.desktop.startReencode(review.token, review.clips.map(clip => clip.id)); onClose(); }
        catch (reason) { setReview(undefined); setError(errorMessage(reason, 'Could not queue proxy encoding.')); }
        finally { setBusy(false); }
    }
    return <ModalDialog titleId="reencode-title" title="Re-Encode Proxies?" busy={busy} onCancel={onClose}>
        <p className="mt-3 text-sm text-zinc-400">Encode from the Library originals into the local cache. Commit the finished proxies to replace the Library copies.</p>
        {review && <ul className="mt-4 max-h-[45vh] overflow-auto text-sm">{review.clips.map(clip =>
            <li key={clip.id} className="break-all border-b border-white/10 py-2">{clip.filename}</li>)}</ul>}
        {!review && !error && <p className="mt-3 text-sm">Checking selected clips…</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={busy} onClick={onClose} className={secondaryButton}>{error ? 'Close' : 'Cancel'}</button>
            {review && <button disabled={busy} onClick={() => void submit()} className={primaryButton}>
                {busy ? 'Queueing…' : `Re-Encode ${review.clips.length} ${review.clips.length === 1 ? 'Proxy' : 'Proxies'}`}</button>}
        </div>
    </ModalDialog>;
}
