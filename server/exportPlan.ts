import type { LibraryMetadata } from '../shared/library';

export interface ExportClipPlan {
    id: string;
    source: string;
    proxy: string;
    fields: Record<string, string>;
}

// The transfer worker consumes paths and metadata documents, without knowing an editor's fields.
export interface ExportFormatter {
    id: 'resolve';
    clip(metadata: LibraryMetadata, extension: string, suffixLength: number): ExportClipPlan;
    manifest(clips: ExportClipPlan[], destination: string, existing?: string): string;
}
