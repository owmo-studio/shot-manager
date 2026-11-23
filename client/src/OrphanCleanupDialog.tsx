import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { OrphanDataReview, OrphanDataResult } from '../../shared/library';
import { dangerButton, inspectorButton, secondaryButton } from './buttonStyles';
import { ModalDialog } from './ModalDialog';

export function OrphanCleanupDialog({ onClose }: { onClose: () => void }) {
    const request = useRef<Promise<OrphanDataReview> | undefined>(undefined);
    const deleting = useRef(false);
    const [review, setReview] = useState<OrphanDataReview | null>(null);
    const [excluded, setExcluded] = useState(new Set<number>());
    const [result, setResult] = useState<OrphanDataResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const files = review?.files.filter(file => !excluded.has(file.id)) ?? [];

    useEffect(() => {
        let cancelled = false;
        request.current ??= window.desktop.reviewOrphanedData();
        void request.current.then(value => {
            if (!cancelled) setReview(value);
        }).catch(reason => {
            if (!cancelled) setError(errorMessage(reason, 'Could not scan the Library for orphaned files.'));
        });
        return () => { cancelled = true; };
    }, []);

    async function confirm() {
        if (!review || !files.length || deleting.current || result || error) return;
        deleting.current = true;
        setBusy(true);
        try {
            setResult(await window.desktop.deleteOrphanedData(review.token, files.map(file => file.id)));
        } catch (reason) {
            setError(errorMessage(reason, 'Could not complete orphan cleanup.'));
        } finally {
            deleting.current = false;
            setBusy(false);
        }
    }

    return <ModalDialog titleId="orphan-cleanup-title" title="Clean Orphaned Data" busy={busy} onCancel={onClose}>
        {!review && !error && <p role="status" className="mt-3 text-sm text-zinc-400">Scanning the Library…</p>}
        {review && !error && !result && <>
            <p className="mt-3 text-sm text-zinc-400">
                {files.length ? `Permanently delete ${files.length} orphaned ${files.length === 1 ? 'file' : 'files'} from the Library?`
                    : review.files.length ? 'All files were excluded.' : 'No orphaned files available for cleanup.'}
            </p>
            {files.length > 0 && <ul aria-label="Orphaned files" className="mt-4 max-h-[45vh] overflow-y-auto rounded-lg border border-white/10">
                {files.map(file => <li key={file.id} className="flex items-center gap-3 border-b border-white/8 p-3 last:border-0">
                    <span className="min-w-0 flex-1 break-all text-sm">{file.filename}</span>
                    <button type="button" className={inspectorButton} disabled={busy}
                        aria-label={`Keep ${file.filename}`} title="Keep file"
                        onClick={() => setExcluded(current => new Set(current).add(file.id))}>×</button>
                </li>)}
            </ul>}
        </>}
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        {result && <>
            <p role="status" className="mt-3 text-sm text-zinc-400">{result.deleted} {result.deleted === 1 ? 'file' : 'files'} deleted.</p>
            {result.stopped && <p role="alert" className="mt-3 text-sm text-red-300">{result.stopped}</p>}
            {result.errors.length > 0 && <ul aria-label="File deletion errors" className="mt-3 max-h-[45vh] space-y-2 overflow-y-auto text-sm text-red-300">
                {result.errors.map(file => <li key={file.filename} className="break-all"><p>{file.filename}</p><p>{file.message}</p></li>)}
            </ul>}
        </>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus type="button" disabled={busy} onClick={onClose} className={secondaryButton}>{result || error ? 'Close' : 'Cancel'}</button>
            {!result && !error && <button type="button" disabled={busy || !files.length} onClick={() => void confirm()} className={dangerButton}>
                {busy ? 'Deleting…' : 'Confirm'}
            </button>}
        </div>
    </ModalDialog>;
}
