import { secondaryButton, dangerButton } from "./buttonStyles";
import { useEffect, useRef } from "react";
import type { VideoShot } from "../../shared/shots";

export function ClipActionDialog({ shots, action, busy, error, onCancel, onConfirm }: {
    shots: VideoShot[]; action: "eject" | "stop"; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
    const label = action === "stop" ? "Stop" : "Eject";
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
    return <dialog ref={dialog} aria-labelledby={`${action}-title`} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
        className="m-auto w-[min(440px,90vw)] rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
        <h2 id={`${action}-title`} className="text-lg font-medium">{action === "stop" ? "Stop Commit?" : `Eject ${shots.length === 1 ? "clip" : `${shots.length} clips`}?`}</h2>
        <p className="mt-3 text-sm text-zinc-400">{action === "eject" ? `Remove ${shots.length === 1 ? "this clip" : "these clips"} from the workspace.` : "Cancel queued and active Commits for these clips."}</p>
        <ul aria-label="Affected clips" className="mt-3 max-h-36 overflow-auto text-xs text-zinc-400">{shots.map(shot => <li key={shot.id} className="truncate py-1" title={shot.filename}>{shot.filename}</li>)}</ul>
        <p className="mt-2 text-xs text-zinc-500">{action === "eject" ? "Files and cached data are kept." : "Clips stay in the workspace."}</p>
        {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={busy} onClick={onCancel} className={secondaryButton}>Cancel</button>
            <button aria-label={`Confirm ${action} clips`} disabled={busy} onClick={onConfirm} className={dangerButton}>{busy ? action === "stop" ? "Stopping…" : "Ejecting…" : label}</button>
        </div>
    </dialog>;
}
