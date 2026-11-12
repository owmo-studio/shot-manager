import type { IngestionReceipt, IngestState, ProxyState } from './ingestion';
import type { ShotOrganization } from './organization';

export interface DiscoveryRequest { id: string; path: string }

export interface VideoMetadata {
    device: { manufacturer: string | null; model: string | null; software: string | null; evidence: string | null };
    codec: { name: string | null; profile: string | null; bitDepth: number | null; chroma: string | null };
    color: { label: string | null; primaries: string | null; transfer: string | null; matrix: string | null; range: string | null; evidence: string | null; confidence: "declared" | "inferred" | "unknown"; conflicts: string[] };
    resolution: { width: number | null; height: number | null; rotation: number; displayWidth: number | null; displayHeight: number | null };
    frameRate: { nominal: number | null; average: number | null; rational: string | null; mode: "constant" | "variable" | "unknown"; evidence: string | null };
}

export interface EmbeddedMetadata {
    label: string;
    format: "xml" | "json" | "text";
    text: string;
}

export function emptyVideoMetadata(): VideoMetadata {
    return {
        device: { manufacturer: null, model: null, software: null, evidence: null },
        codec: { name: null, profile: null, bitDepth: null, chroma: null },
        color: { label: null, primaries: null, transfer: null, matrix: null, range: null, evidence: null, confidence: "unknown", conflicts: [] },
        resolution: { width: null, height: null, rotation: 0, displayWidth: null, displayHeight: null },
        frameRate: { nominal: null, average: null, rational: null, mode: "unknown", evidence: null },
    };
}

export const VIDEO_SAMPLE_SCHEME = 'sampled-sha256-v2' as const;

export interface VideoFingerprint {
    algorithm: 'sha256';
    scheme: typeof VIDEO_SAMPLE_SCHEME;
    value: string;
    fileSize: number;
    sampleBytes: number;
    sampledBytes: number;
}

export interface VideoShot {
    // Published clips use fingerprint.value; paths describe occurrences, never clip identity.
    id: string;
    filePath: string;
    filename: string;
    relativePath: string;
    bytes: number;
    timestamp: string;
    dateSource: "camera" | "embedded" | "file-modified";
    dateEvidence: string;
    dateConfidence: "declared" | "uncertain";
    cameraModel: string | null;
    durationSeconds: number | null;
    metadata: VideoMetadata;
    fingerprint?: VideoFingerprint;
    organization?: ShotOrganization;
    hasThumbnail: boolean;
    hasCustomThumbnail?: boolean;
    thumbnailRevision?: number;
    thumbnailStatus?: "pending" | "ready" | "failed";
    warnings: string[];
    available: boolean;
    // Draft-edit eligibility is independent of source availability; discovery preparation and Commit locks block edits.
    editable: boolean;
    ingestion?: IngestionReceipt;
    ingestState?: IngestState;
    thumbnailDigest?: string;
    proxyState?: ProxyState;
    proxyLocation?: 'cache' | 'library';
    proxyPercent?: number;
    proxyError?: string;
    transferPercent?: number;
}

export interface DiscoveryScan {
    discoveryId: string;
    path?: string;
    state: "queued" | "scanning" | "complete" | "failed" | "interrupted";
    clipCount: number;
    warnings: string[];
    error?: string;
}

export interface DirectoryAvailability {
    path: string;
    available: boolean;
    clipIds: string[];
    outage: number;
}

export interface ShotCollection {
    revision: number;
    shots: VideoShot[];
    scans: DiscoveryScan[];
    directories?: DirectoryAvailability[];
}

// Transient main/backend handoff during Clear Cache; never persisted or renderer-supplied.
export interface WorkspaceRestore {
    files: string[];
    scans: { path: string; files?: string[] }[];
    excludedIds: string[];
}

export interface ShotChange { revision: number; vocabularyRevision: number }

export interface ShotDetails {
    file: { filename: string; path: string; bytes: number };
    metadata: VideoMetadata;
    fingerprint?: VideoFingerprint;
    embeddedMetadata: EmbeddedMetadata[];
    mediaInfo: Record<string, unknown> | null;
    errors: string[];
}
