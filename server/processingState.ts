import { createHash } from 'node:crypto';
import { ingestAttributes } from '../shared/ingestion';
import type { ClipAttributes } from '../shared/organization';

export function ingestionSignature(attributes: ClipAttributes, thumbnailDigest: string) {
    const { group, camera, rating, ...original } = ingestAttributes(attributes);
    // Empty additions retain the signature of receipts written before these fields existed.
    const state = { ...original, ...(group ? { group } : {}), ...(camera ? { camera } : {}), ...(rating ? { rating } : {}) };
    return createHash('sha256').update(JSON.stringify([state, thumbnailDigest])).digest('hex');
}
