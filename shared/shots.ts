export interface VideoShot {
    id: string;
    sourceId: string;
    filename: string;
    relativePath: string;
    bytes: number;
    timestamp: string;
    dateSource: "camera" | "embedded" | "file-modified";
    cameraModel: string | null;
    durationSeconds: number | null;
    hasProxy: boolean;
    hasThumbnail: boolean;
    thumbnailStatus?: "pending" | "ready" | "failed";
    hasXml: boolean;
    warnings: string[];
    available: boolean;
    editable: boolean;
}

export interface SourceScan {
    sourceId: string;
    state: "queued" | "scanning" | "complete" | "failed" | "interrupted";
    clipCount: number;
    warnings: string[];
    error?: string;
}

export interface ShotCollection {
    revision: number;
    shots: VideoShot[];
    scans: SourceScan[];
}
