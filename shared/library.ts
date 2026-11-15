import type { ClipAttributes } from './organization';
import type { ShotCollection, VideoFingerprint, VideoMetadata } from './shots';
import { VIDEO_SAMPLE_SCHEME } from './shots';
import { validateClipAttributes } from './organization';

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

export interface LibraryCollection extends ShotCollection {
    libraryPath: string | null;
    refreshedAt?: string;
    refreshing: boolean;
    error?: string;
    warnings: string[];
}

export interface LibraryDeleteReview {
    token: string;
    clips: { id: string; filename: string }[];
}
export interface LibraryDeleteResult {
    deleted: string[];
    errors: { id: string; filename: string; message: string }[];
}

export function validateLibraryMetadata(value: unknown, id: string): LibraryMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Library metadata.');
    const data = value as LibraryMetadata;
    const fingerprint = data.fingerprint;
    if (data.id !== id || !/^[a-f0-9]{64}$/.test(id) || fingerprint?.value !== id || fingerprint.scheme !== VIDEO_SAMPLE_SCHEME ||
        fingerprint.algorithm !== 'sha256' || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || fingerprint.fileSize !== data.bytes ||
        !Number.isSafeInteger(fingerprint.sampleBytes) || fingerprint.sampleBytes <= 0 || !Number.isSafeInteger(fingerprint.sampledBytes) || fingerprint.sampledBytes < 0 ||
        typeof data.originalFilename !== 'string' || !data.originalFilename || /[\0/]/.test(data.originalFilename) ||
        typeof data.recordedAt !== 'string' || !Number.isFinite(Date.parse(data.recordedAt)) ||
        !['camera', 'embedded', 'file-modified'].includes(data.dateSource) || !['declared', 'uncertain'].includes(data.dateConfidence) ||
        typeof data.dateEvidence !== 'string' || !(data.durationSeconds === null || Number.isFinite(data.durationSeconds) && data.durationSeconds >= 0) ||
        !Array.isArray(data.warnings) || data.warnings.some(warning => typeof warning !== 'string') ||
        !data.ingestion || data.ingestion.transfer !== 'rsync' || !Number.isFinite(Date.parse(data.ingestion.completedAt))) throw new Error(`Invalid Library metadata for ${id}.`);
    const metadata = data.metadata;
    const text = (value: unknown) => value === null || typeof value === 'string';
    const number = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!metadata || !metadata.device || !metadata.codec || !metadata.color || !metadata.resolution || !metadata.frameRate ||
        !['manufacturer', 'model', 'software', 'evidence'].every(key => text(metadata.device[key as keyof typeof metadata.device])) ||
        !['name', 'profile', 'chroma'].every(key => text(metadata.codec[key as 'name' | 'profile' | 'chroma'])) || !number(metadata.codec.bitDepth) ||
        !['label', 'primaries', 'transfer', 'matrix', 'range', 'evidence'].every(key => text(metadata.color[key as 'label'])) ||
        !['declared', 'inferred', 'unknown'].includes(metadata.color.confidence) ||
        !Array.isArray(metadata.color.conflicts) || metadata.color.conflicts.some(item => typeof item !== 'string') ||
        !['width', 'height', 'displayWidth', 'displayHeight'].every(key => number(metadata.resolution[key as 'width'])) || !Number.isFinite(metadata.resolution.rotation) ||
        !number(metadata.frameRate.nominal) || !number(metadata.frameRate.average) || !text(metadata.frameRate.rational) || !text(metadata.frameRate.evidence) ||
        !['constant', 'variable', 'unknown'].includes(metadata.frameRate.mode)) throw new Error(`Invalid technical metadata for ${id}.`);
    // Retain additional fields written by other tools when publishing descriptive edits.
    return { ...data, ...validateClipAttributes(data) };
}
