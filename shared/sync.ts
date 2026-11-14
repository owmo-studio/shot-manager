export interface SyncReview {
    token: string;
    destinationPath: string;
    format: 'resolve';
    clips: { id: string; filename: string; bytes: number; mode: 'new' | 'replace'; issue?: string; outputFilename?: string }[];
}
