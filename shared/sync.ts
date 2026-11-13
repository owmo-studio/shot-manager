export interface SyncReview {
    token: string;
    destinationPath: string;
    format: 'direct-copy';
    clips: { id: string; filename: string; bytes: number; mode: 'new' | 'replace'; issue?: string }[];
}
