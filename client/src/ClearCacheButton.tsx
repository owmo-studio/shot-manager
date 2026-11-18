import { secondaryButton, dangerButton, dangerSecondaryButton } from "./buttonStyles";
import { errorMessage } from '../../shared/errors';
import { useEffect, useRef, useState } from 'react';
import type { CacheSelection } from '../../shared/desktop';

const cacheKinds = [
    { key: 'catalogue', label: 'Library catalogue', detail: 'The local view of Library metadata; pending edits are kept' },
    { key: 'metadata', label: 'Metadata', detail: 'Attributes, thumbnail choices, saved options, Commit receipts' },
    { key: 'thumbnails', label: 'Thumbnails', detail: 'Generated and assigned thumbnails' },
    { key: 'fingerprints', label: 'Fingerprints', detail: 'Source lookup records' },
    { key: 'proxies', label: 'Proxies', detail: 'Local encoded proxies' },
] as const;
const allSelected: Required<CacheSelection> = {
    catalogue: true, metadata: true, thumbnails: true, fingerprints: true, proxies: true,
};

export function ClearCacheButton({ disabled, onBusyChange, onReset }: {
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
    onReset: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState(allSelected);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const hasSelection = cacheKinds.some(kind => selected[kind.key]);

    useEffect(() => {
        if (!open) return;
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, [open]);

    function close() {
        if (busy) return;
        setOpen(false);
        onBusyChange(false);
    }

    async function clear() {
        if (busy || !hasSelection) return;
        setBusy(true); setError(null);
        try {
            await window.desktop.clearLocalData(selected);
            setOpen(false);
            onReset();
        } catch (reason) {
            setError(errorMessage(reason, 'Cache could not be cleared. Some selected files may have been removed.'));
        } finally { setBusy(false); onBusyChange(false); }
    }

    return <>
        <button type="button" disabled={disabled} onClick={() => {
            setSelected(allSelected);
            setError(null); setOpen(true); onBusyChange(true);
        }} className={dangerSecondaryButton}>Clear Cache</button>
        {open && <dialog ref={dialog} role="alertdialog" aria-labelledby="clear-cache-title"
            onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
            className="m-auto max-h-[calc(100vh-48px)] w-[480px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
            <h2 id="clear-cache-title" className="text-lg font-medium">Clear Cache?</h2>
            <div className="mt-4 space-y-3">
                {cacheKinds.map(kind => <label key={kind.key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 p-3 text-sm hover:bg-white/5">
                    <input type="checkbox" checked={selected[kind.key]} disabled={busy} onChange={event => {
                        const checked = event.currentTarget.checked;
                        setSelected(current => ({ ...current, [kind.key]: checked }));
                    }} aria-label={`Delete ${kind.label.toLowerCase()}`} className="mt-0.5 accent-blue-500" />
                    <span><span className="block text-zinc-200">{kind.label}</span><span className="block text-xs text-zinc-500">{kind.detail}</span></span>
                </label>)}
            </div>
            {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
                <button autoFocus type="button" disabled={busy} onClick={close} className={secondaryButton}>Cancel</button>
                <button type="button" aria-label="Confirm clear cache" disabled={busy || !hasSelection} onClick={() => void clear()}
                    className={dangerButton}>{busy ? 'Clearing…' : 'Clear Cache'}</button>
            </div>
        </dialog>}
    </>;
}
