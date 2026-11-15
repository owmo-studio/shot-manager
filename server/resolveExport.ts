import { extname } from 'node:path';
import type { ExportFormatter } from './exportPlan';

// "Rating" is Resolve's built-in star field; keep our Preferred/Usable value in custom "Quality".
const columns = ['File Name', 'Clip Directory', 'Clip Name', 'Description', 'Scene', 'Camera #', 'Good Take', 'Comments', 'Keywords',
    'Identity', 'Project', 'Group', 'Camera', 'Quality'];
// Resolve fails filename matching when ordinary values are unnecessarily quoted.
// Quote only fields that need CSV escaping, as in Resolve's own metadata export.
const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export const resolveFormatter: ExportFormatter = {
    id: 'resolve',
    clip(metadata, extension, suffixLength) {
        const originalExtension = extname(metadata.originalFilename);
        const rawStem = (originalExtension ? metadata.originalFilename.slice(0, -originalExtension.length) : metadata.originalFilename)
            .normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '_').trim().replace(/[. ]+$/g, '') || 'clip';
        const suffix = metadata.id.slice(0, suffixLength);
        const budget = 255 - Math.max(Buffer.byteLength(`.${extension}`), Buffer.byteLength('.mov')) - suffix.length - 2;
        let stem = '';
        for (const character of rawStem) { if (Buffer.byteLength(stem + character) > budget) break; stem += character; }
        if (!stem) throw new Error('Original filename cannot be exported safely.');
        const base = `${stem}__${suffix}`;
        const source = `${base}.${extension}`, proxy = `Proxy/${base}.mov`;
        const descriptive = [metadata.identity, metadata.project, metadata.scene, metadata.camera].filter(Boolean);
        const clipName = descriptive.length ? [...descriptive, originalExtension ? metadata.originalFilename.slice(0, -originalExtension.length) : metadata.originalFilename].join(' · ') : base;
        const keywords = [...metadata.tags, ...(metadata.identity ? [`identity:${metadata.identity}`] : []),
            ...(metadata.project ? [`project:${metadata.project}`] : []), ...(metadata.rating ? [`rating:${metadata.rating}`] : [])];
        return { id: metadata.id, source, proxy,
            fields: { 'Clip Name': clipName, Description: metadata.scene, Scene: metadata.group, 'Camera #': metadata.camera,
                'Good Take': metadata.rating === 'preferred' ? '1' : metadata.rating === 'usable' ? '0' : '', Comments: metadata.notes,
                Keywords: [...new Set(keywords)].join(', '), 'Identity': metadata.identity ?? '', 'Project': metadata.project ?? '',
                'Group': metadata.group, 'Camera': metadata.camera, 'Quality': metadata.rating ?? '' } };
    },
    manifest(clips, destination) {
        const rows = clips.map(clip => columns.map(column => column === 'File Name' ? clip.source : column === 'Clip Directory' ? destination : clip.fields[column] ?? ''));
        return [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    },
};
