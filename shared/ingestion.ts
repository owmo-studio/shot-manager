import type { ClipAttributes } from './organization';

export interface IngestionReceipt {
    libraryPath: string;
    signature: string;
    ingestedAt: string;
    thumbnailDigest?: string;
}

export type IngestState = 'synced' | 'changes-pending' | 'queued' | 'processing' | 'unverified';
export type ProxyState = 'missing' | 'queued' | 'encoding' | 'ready' | 'unverified' | 'failed';
export interface IngestReview {
    token: string;
    libraryPath: string;
    proxyPreparation?: boolean;
    metadataOnly?: boolean;
    libraryEdits?: boolean;
    clips: { id: string; filename: string; bytes: number; mode: 'new' | 'replace'; proxyReady: boolean; files: { from: string; to: string }[] }[];
}

export interface IngestStatus {
    revision: number;
    libraryPath?: string | null;
    libraryScan?: { state: 'checking' | 'ready' | 'unavailable'; scannedAt?: string; error?: string };
    active: boolean;
    stopping: boolean;
    position: number;
    total: number;
    completed?: number;
    waiting?: number;
    tasks?: { completed: number; total: number; percent: number; proxiesRemaining: number; transfersRemaining: number };
    work?: { paused: boolean; busy: boolean; encoding: boolean; queued: number; scratchPath: string | null; error?: string };
    current?: { id: string; filename: string; percent: number; phase: 'transferring' | 'metadata' };
    errors: { id: string; filename: string; message: string; eventId: string }[];
    acceptedReviews?: string[];
}

// Stable descriptive state: Skip and selection deliberately do not contribute.
export function ingestAttributes(attributes: ClipAttributes): ClipAttributes {
    return { identity: attributes.identity, project: attributes.project, scene: attributes.scene,
        notes: attributes.notes, tags: [...attributes.tags] };
}
