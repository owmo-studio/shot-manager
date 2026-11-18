import { useClipView } from "./ClipViewContext";
import { secondaryButton, dangerButton, smallDangerButton } from "./buttonStyles";
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { ShotCollection, VideoShot } from '../../shared/shots';
import type { TagVocabulary } from '../../shared/organization';

export function RevertOrganizationButton({ shots, onReverted }: {
    shots: VideoShot[];
    onReverted: (result: { collection: ShotCollection; vocabulary: TagVocabulary }) => void;
}) {
    const { api, mode } = useClipView();
    const candidates = shots.filter(shot => shot.ingestState === 'changes-pending');
    const [targets, setTargets] = useState<VideoShot[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const disabled = !candidates.length || candidates.some(shot => !shot.editable || !shot.fingerprint || !shot.organization);
    useEffect(() => {
        if (!targets) return;
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, [targets]);

    async function revert() {
        if (!targets || busy) return;
        setBusy(true); setError(null);
        try {
            const result = await api.revertOrganization(targets.map(shot => shot.id));
            onReverted(result);
            setTargets(null);
        } catch (reason) {
            setError(errorMessage(reason, 'Could not restore Library attributes and thumbnails.'));
        } finally { setBusy(false); }
    }

    return <>
        <button type="button" aria-label="Revert pending clip attributes" title="Restore attributes and thumbnails from the Library"
            disabled={disabled || busy} onClick={() => { setError(null); setTargets([...candidates]); }}
            className={smallDangerButton}>Revert</button>
        {targets && <dialog ref={dialog} role="alertdialog" aria-labelledby="revert-organization-title" aria-describedby="revert-organization-description"
            onCancel={event => { event.preventDefault(); if (!busy) setTargets(null); }}
            className="m-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
            <h2 id="revert-organization-title" className="text-lg font-medium">Revert Changes?</h2>
            <p id="revert-organization-description" className="mt-3 text-sm leading-6 text-zinc-400">
                Replace local attributes and thumbnails with Library values for {targets.length} {targets.length === 1 ? 'clip' : 'clips'}.
            </p>
            {mode === "import" && <p className="mt-2 text-xs text-zinc-500">Skip is kept.</p>}
            {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
                <button autoFocus type="button" disabled={busy} onClick={() => setTargets(null)} className={secondaryButton}>Cancel</button>
                <button type="button" aria-label="Confirm revert clip attributes" disabled={busy} onClick={() => void revert()}
                    className={dangerButton}>{busy ? 'Reverting…' : 'Revert'}</button>
            </div>
        </dialog>}
    </>;
}
