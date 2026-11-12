import { useEffect, useRef } from "react";
import type { DirectoryAvailability } from "../../shared/shots";

export function DirectoryUnavailableDialog({ directories, onDismiss, onEject }: {
    directories: DirectoryAvailability[]; onDismiss: () => void; onEject: (ids: string[]) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const ids = [...new Set(directories.flatMap(directory => directory.clipIds))];
    useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
    return <dialog ref={dialog} aria-labelledby="unavailable-directory-title" onCancel={event => { event.preventDefault(); onDismiss(); }}
        className="m-auto w-[min(520px,90vw)] rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
        <h2 id="unavailable-directory-title" className="text-lg font-medium">Media unavailable</h2>
        <p className="mt-3 text-sm text-zinc-400">{ids.length} {ids.length === 1 ? "clip is" : "clips are"} affected. Reconnect the folder or eject the affected clips.</p>
        <ul className="mt-4 max-h-64 space-y-3 overflow-auto">{directories.map(directory => <li key={directory.path}>
            <p className="break-all text-xs text-zinc-300">{directory.path}</p>
            <p className="mt-1 text-xs text-zinc-500">{directory.clipIds.length} {directory.clipIds.length === 1 ? "clip" : "clips"}</p>
        </li>)}</ul>
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus onClick={onDismiss} className="rounded-md border border-white/15 px-3 py-1.5 text-xs hover:bg-white/8">Dismiss</button>
            <button onClick={() => onEject(ids)} className="rounded-md border border-white/15 px-3 py-1.5 text-xs hover:bg-white/8">Eject affected clips</button>
        </div>
    </dialog>;
}
