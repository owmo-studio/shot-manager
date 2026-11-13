import type { VideoShot } from '../../shared/shots';

// Waiting and transferring Commits share the same edit lock and Stop action.
export function hasPendingCommit(shot: Pick<VideoShot, 'ingestState'>) {
    return shot.ingestState === 'queued' || shot.ingestState === 'processing';
}
