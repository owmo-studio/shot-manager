import { useEffect, useRef } from "react";
import type { VideoShot } from "../../shared/shots";

export function EjectDialog({ shots, busy, error, onCancel, onConfirm }: {
    shots: VideoShot[]; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
    return <dialog ref={dialog} aria-labelledby="eject-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
        className="m-auto w-[min(440px,90vw)] rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
        <h2 id="eject-title" className="text-lg font-medium">Eject {shots.length === 1 ? "clip" : `${shots.length} clips`}?</h2>
        <p className="mt-3 text-sm leading-6 text-zinc-400">Some clips are queued or committing. Eject cancels their unfinished work and removes them from the workspace.</p>
        <p className="mt-2 text-xs leading-5 text-zinc-500">Files, completed Library copies, cached information, and completed proxies are kept.</p>
        <ul className="mt-3 max-h-36 overflow-auto text-xs text-zinc-400">{shots.map(shot => <li key={shot.id} className="truncate py-1">{shot.filename}</li>)}</ul>
        {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={busy} onClick={onCancel} className="rounded-md border border-white/15 px-3 py-1.5 text-xs hover:bg-white/8 disabled:opacity-40">Cancel</button>
            <button aria-label="Confirm eject clips" disabled={busy} onClick={onConfirm} className="rounded-md bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-500 disabled:opacity-40">{busy ? "Ejecting…" : "Eject"}</button>
        </div>
    </dialog>;
}
