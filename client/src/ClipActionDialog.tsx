import { secondaryButton, dangerButton } from "./buttonStyles";
import type { VideoShot } from "../../shared/shots";
import { ModalDialog } from './ModalDialog';

export function ClipActionDialog({ shots, action, busy, error, onCancel, onConfirm }: {
    shots: VideoShot[]; action: "eject" | "stop"; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
    const label = action === "stop" ? "Stop" : "Eject";
    return <ModalDialog titleId={`${action}-title`} busy={busy} onCancel={onCancel} width="w-[min(440px,90vw)]"
        title={action === "stop" ? "Stop Commit?" : `Eject ${shots.length === 1 ? "clip" : `${shots.length} clips`}?`}>
        <p className="mt-3 text-sm text-zinc-400">{action === "eject" ? `Remove ${shots.length === 1 ? "this clip" : "these clips"} from the workspace.` : "Cancel queued and active Commits for these clips."}</p>
        <ul aria-label="Affected clips" className="mt-3 max-h-36 overflow-auto text-xs text-zinc-400">{shots.map(shot => <li key={shot.id} className="truncate py-1" title={shot.filename}>{shot.filename}</li>)}</ul>
        <p className="mt-2 text-xs text-zinc-500">{action === "eject" ? "Files and cached data are kept." : "Clips stay in the workspace."}</p>
        {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={busy} onClick={onCancel} className={secondaryButton}>Cancel</button>
            <button aria-label={`Confirm ${action} clips`} disabled={busy} onClick={onConfirm} className={dangerButton}>{busy ? action === "stop" ? "Stopping…" : "Ejecting…" : label}</button>
        </div>
    </ModalDialog>;
}
