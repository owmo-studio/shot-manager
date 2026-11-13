import { createHash } from 'node:crypto';
import { ingestAttributes } from '../shared/ingestion';
import type { ClipAttributes } from '../shared/organization';

export function ingestionSignature(attributes: ClipAttributes, thumbnailDigest: string) {
    return createHash('sha256').update(JSON.stringify([ingestAttributes(attributes), thumbnailDigest])).digest('hex');
}
