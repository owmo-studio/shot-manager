import type { ClipAttributes } from '../../shared/organization';
import type { VideoShot } from '../../shared/shots';
import { thumbnailChanged, valuesEqual } from '../../shared/clipState';

export type LibraryAttributeField = keyof ClipAttributes;

function value(attributes: ClipAttributes | undefined, field: LibraryAttributeField) {
    if (attributes) return attributes[field];
    return field === 'identity' || field === 'project' || field === 'rating' ? null : field === 'tags' ? [] : '';
}

export function libraryAttributeChanged(shots: VideoShot[], field: LibraryAttributeField) {
    return shots.some(shot => shot.ingestState === 'changes-pending' && !!shot.libraryBaseline &&
        !valuesEqual(value(shot.organization, field), value(shot.libraryBaseline, field)));
}

export function libraryThumbnailChanged(shot: VideoShot) {
    return shot.ingestState === 'changes-pending' && !!shot.ingestion?.thumbnailDigest &&
        thumbnailChanged(shot.thumbnailDigest, shot.ingestion.thumbnailDigest);
}
