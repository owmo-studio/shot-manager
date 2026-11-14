import type { LibraryMetadata } from '../shared/library';

export interface ExportClipPlan {
    id: string;
    source: string;
    proxy: string;
    metadata: { path: string; content: string };
    fields: Record<string, string>;
}

// The transfer worker consumes paths/documents, without knowing an editor's fields.
export interface ExportFormatter {
    id: 'resolve';
    clip(metadata: LibraryMetadata, extension: string, suffixLength: number): ExportClipPlan;
    manifest(clips: ExportClipPlan[], destination: string): string;
}
