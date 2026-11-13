import type { ClipAttributes } from './organization';
import type { VideoFingerprint, VideoMetadata } from './shots';

export type LibraryRole = 'source' | 'thumb' | 'metadata' | 'proxy';

export function libraryAssetName(id: string, role: LibraryRole, extension: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^(source|thumb|metadata|proxy)$/.test(role) || !/^[a-z0-9]+$/.test(extension)) {
        throw new Error('Invalid Library asset identifier.');
    }
    return `${id}.${role}.${extension}`;
}

// Published reserved roles only. Temporary files and other tools' derived roles stay untouched.
export function parseLibraryAssetName(name: string) {
    if (name.endsWith('.partial')) return null;
    const match = /^([a-f0-9]{64})\.(source|thumb|metadata|proxy)\.([a-z0-9]+)$/.exec(name);
    return match ? { id: match[1], role: match[2] as LibraryRole, extension: match[3] } : null;
}

// Persisted JSON, independent of workspace membership, source paths, and local receipts.
export interface LibraryMetadata extends ClipAttributes {
    id: string;
    fingerprint: VideoFingerprint;
    originalFilename: string;
    bytes: number;
    recordedAt: string;
    dateSource: 'camera' | 'embedded' | 'file-modified';
    dateEvidence: string;
    dateConfidence: 'declared' | 'uncertain';
    durationSeconds: number | null;
    metadata: VideoMetadata;
    warnings: string[];
    ingestion: { completedAt: string; transfer: 'rsync' };
}
