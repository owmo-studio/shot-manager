import { secondaryButton, dangerButton } from "./buttonStyles";
import { errorMessage } from '../../shared/errors';
import { useEffect, useRef, useState } from 'react';
import type { CacheSelection } from '../../shared/desktop';

const cacheKinds = [
    { key: 'metadata', label: 'Metadata', detail: 'Attributes, saved options, Commit receipts' },
    { key: 'thumbnails', label: 'Thumbnails', detail: 'Generated and assigned thumbnails' },
    { key: 'fingerprints', label: 'Fingerprints', detail: 'Source lookup records' },
    { key: 'proxies', label: 'Proxies', detail: 'Local encoded proxies' },
] as const;

export function ResetLocalDataButton({ disabled, onBusyChange, onReset }: {
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
    onReset: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [keep, setKeep] = useState<Record<keyof CacheSelection, boolean>>({ metadata: false, thumbnails: false, fingerprints: false, proxies: false });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);

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
        if (busy || cacheKinds.every(kind => keep[kind.key])) return;
        setBusy(true); setError(null);
        try {
            await window.desktop.clearLocalData({
                metadata: !keep.metadata, thumbnails: !keep.thumbnails,
                fingerprints: !keep.fingerprints, proxies: !keep.proxies,
            });
            setOpen(false);
            onReset();
        } catch (reason) {
            setError(errorMessage(reason, 'Cache could not be cleared. Some selected files may have been removed.'));
        } finally { setBusy(false); onBusyChange(false); }
    }

    return <>
        <button type="button" disabled={disabled} onClick={() => {
            setKeep({ metadata: false, thumbnails: false, fingerprints: false, proxies: false });
            setError(null); setOpen(true); onBusyChange(true);
        }} className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 transition enabled:hover:bg-red-500/20 enabled:hover:text-red-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 disabled:opacity-40">Clear Cache</button>
        {open && <dialog ref={dialog} role="alertdialog" aria-labelledby="clear-cache-title" aria-describedby="clear-cache-description"
            onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
            className="m-auto max-h-[calc(100vh-48px)] w-[480px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
            <h2 id="clear-cache-title" className="text-lg font-medium">Clear Cache?</h2>
            <p id="clear-cache-description" className="mt-3 text-sm leading-6 text-zinc-300">Delete cached data in unchecked categories.</p>
            <div className="mt-4 space-y-3">
                {cacheKinds.map(kind => <label key={kind.key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 p-3 text-sm hover:bg-white/5">
                    <input type="checkbox" checked={keep[kind.key]} disabled={busy} onChange={event => setKeep(current => ({ ...current, [kind.key]: event.target.checked }))}
                        aria-label={`Keep ${kind.label.toLowerCase()}`} className="mt-0.5 accent-blue-500" />
                    <span><span className="block text-zinc-200">Keep {kind.label.toLowerCase()}</span><span className="block text-xs text-zinc-500">{kind.detail}</span></span>
                </label>)}
            </div>
            <p className="mt-3 text-xs text-zinc-500">Library files and original videos are kept.</p>
            {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
                <button autoFocus type="button" disabled={busy} onClick={close} className={secondaryButton}>Cancel</button>
                <button type="button" aria-label="Confirm clear cache" disabled={busy || cacheKinds.every(kind => keep[kind.key])} onClick={() => void clear()}
                    className={dangerButton}>{busy ? 'Clearing…' : 'Clear Cache'}</button>
            </div>
        </dialog>}
    </>;
}
