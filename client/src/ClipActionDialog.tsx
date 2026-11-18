import { secondaryButton, dangerButton } from "./buttonStyles";
import type { VideoShot } from "../../shared/shots";
import type { StoppableTransfer } from "../../shared/ingestion";
import { ModalDialog } from './ModalDialog';

export function ClipActionDialog({ shots, action, busy, error, onCancel, onConfirm }: {
    shots: VideoShot[]; action: "eject" | StoppableTransfer; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
    const ejecting = action === "eject";
    const verb = ejecting ? "eject" : "stop";
    const work = action === 'sync' ? 'Export' : 'Commit';
    const selection = shots.length === 1 ? "this clip" : "these clips";
    return <ModalDialog titleId={`${verb}-title`} busy={busy} onCancel={onCancel} width="w-[min(440px,90vw)]"
        title={ejecting ? `Eject ${shots.length === 1 ? "clip" : `${shots.length} clips`}?` : `Stop ${work}?`}>
        <p className="mt-3 text-sm text-zinc-400">{ejecting ? `Remove ${selection} from the workspace.` : `Remove ${selection} from the ${work} queue.`}</p>
        <ul aria-label="Affected clips" className="mt-3 max-h-36 overflow-auto text-xs text-zinc-400">{shots.map(shot => <li key={shot.id} className="truncate py-1" title={shot.filename}>{shot.filename}</li>)}</ul>
        <p className="mt-2 text-xs text-zinc-500">{ejecting ? "Files and cached data are kept." : action === 'sync' ? "Clips stay in the Library." : "Clips stay in the workspace."}</p>
        {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
            <button autoFocus disabled={busy} onClick={onCancel} className={secondaryButton}>Cancel</button>
            <button aria-label={`Confirm ${verb} clips`} disabled={busy} onClick={onConfirm} className={dangerButton}>
                {ejecting ? (busy ? "Ejecting…" : "Eject") : (busy ? "Stopping…" : "Stop")}
            </button>
        </div>
    </ModalDialog>;
}
