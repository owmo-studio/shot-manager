import type { ClipAttributes } from './organization';

export interface IngestionReceipt {
    libraryPath: string;
    signature: string;
    ingestedAt: string;
    thumbnailDigest?: string;
}

export type IngestState = 'synced' | 'changes-pending' | 'queued' | 'processing' | 'unverified';
export type ProxyState = 'missing' | 'queued' | 'encoding' | 'ready' | 'unverified' | 'failed';
export type WorkQueue = 'proxy' | 'commit' | 'sync';
export type StoppableTransfer = Exclude<WorkQueue, 'proxy'>;
export const isWorkQueue = (value: unknown): value is WorkQueue => value === 'proxy' || value === 'commit' || value === 'sync';
export interface IngestReview {
    token: string;
    libraryPath: string;
    proxyPreparation?: boolean;
    metadataOnly?: boolean;
    libraryEdits?: boolean;
    clips: { id: string; filename: string; bytes: number; mode: 'new' | 'replace' | 'synced'; proxyReady: boolean; files: { from: string; to: string }[] }[];
}

export interface IngestStatus {
    revision: number;
    libraryPath?: string | null;
    libraryScan?: { state: 'checking' | 'ready' | 'unavailable'; scannedAt?: string; error?: string };
    active: boolean;
    stopping: boolean;
    pausedQueues?: Partial<Record<WorkQueue, boolean>>;
    metadataActive?: boolean;
    metadataPending?: number;
    position: number;
    total: number;
    completed?: number;
    waiting?: number;
    tasks?: { completed: number; total: number; percent: number; proxiesRemaining: number; transfersRemaining: number; syncsRemaining?: number;
        sync?: { completed: number; total: number; percent: number } };
    // Internal refresh signal for metadata-only Library saves. These saves do not
    // get a fourth progress bar.
    metadataRevision?: number;
    work?: { paused: boolean; busy: boolean; encoding: boolean; queued: number; scratchPath: string | null; error?: string;
        current?: { id: string; percent: number } };
    // Independent active transfer lanes; current is the Commit worker.
    current?: { id: string; filename: string; percent: number; phase: 'transferring' | 'metadata'; kind?: 'commit' | 'sync' };
    exportCurrent?: IngestStatus['current'];
    errors: { id: string; filename: string; message: string; eventId: string; kind?: 'commit' | 'sync' | 'proxy' }[];
    acceptedReviews?: string[];
}

// Stable descriptive state: Skip and selection deliberately do not contribute.
export function ingestAttributes(attributes: ClipAttributes): ClipAttributes {
    return { identity: attributes.identity, project: attributes.project, scene: attributes.scene,
        notes: attributes.notes, tags: [...attributes.tags], group: attributes.group ?? '', camera: attributes.camera ?? '', rating: attributes.rating ?? null };
}
