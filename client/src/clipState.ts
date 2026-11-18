import type { VideoShot } from '../../shared/shots';
import type { StoppableTransfer } from '../../shared/ingestion';

// Waiting and transferring Commits share the same edit lock and Stop action.
export function hasPendingCommit(shot: Pick<VideoShot, 'ingestState'>) {
    return shot.ingestState === 'queued' || shot.ingestState === 'processing';
}

export function canStopClip(shot: VideoShot, kind: StoppableTransfer) {
    return hasPendingCommit(shot) && shot.workKind === (kind === 'sync' ? 'sync' : undefined);
}
