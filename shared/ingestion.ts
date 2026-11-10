import type { ClipAttributes } from './organization';

export interface IngestionReceipt {
    libraryPath: string;
    signature: string;
    ingestedAt: string;
}

export type IngestState = 'synced' | 'changes-pending' | 'queued' | 'processing' | 'unverified';
export interface IngestReview {
    token: string;
    libraryPath: string;
    clips: { id: string; filename: string; bytes: number; mode: 'new' | 'replace'; files: { from: string; to: string }[] }[];
}

export interface IngestStatus {
    revision: number;
    libraryPath?: string | null;
    libraryScan?: { state: 'checking' | 'ready' | 'unavailable'; scannedAt?: string; error?: string };
    active: boolean;
    stopping: boolean;
    position: number;
    total: number;
    current?: { id: string; filename: string; percent: number; phase: 'transferring' | 'metadata' };
    errors: { id: string; filename: string; message: string; eventId: string }[];
}

// Stable descriptive state: Skip and selection deliberately do not contribute.
export function ingestAttributes(attributes: ClipAttributes): ClipAttributes {
    return { identity: attributes.identity, project: attributes.project, scene: attributes.scene,
        notes: attributes.notes, tags: [...attributes.tags] };
}
