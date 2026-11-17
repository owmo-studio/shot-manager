import type { ClipAttributes } from '../../shared/organization';
import type { VideoShot } from '../../shared/shots';

export type LibraryAttributeField = keyof ClipAttributes;

function value(attributes: ClipAttributes | undefined, field: LibraryAttributeField) {
    if (attributes) return attributes[field];
    return field === 'identity' || field === 'project' || field === 'rating' ? null : field === 'tags' ? [] : '';
}

export function libraryAttributeChanged(shots: VideoShot[], field: LibraryAttributeField) {
    return shots.some(shot => shot.ingestState === 'changes-pending' && !!shot.libraryBaseline &&
        JSON.stringify(value(shot.organization, field)) !== JSON.stringify(value(shot.libraryBaseline, field)));
}

export function libraryThumbnailChanged(shot: VideoShot) {
    return shot.ingestState === 'changes-pending' && !!shot.ingestion?.thumbnailDigest &&
        !!shot.thumbnailDigest && shot.ingestion.thumbnailDigest !== shot.thumbnailDigest;
}
