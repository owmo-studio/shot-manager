import { readResolveTimecode } from './resolveTimecode';
import { extname } from 'node:path';
import type { ExportFormatter } from './exportPlan';

// "Rating" is Resolve's built-in star field; keep our Quality value in custom "Quality".
const names = ['File Name', 'Clip Directory', 'Clip Name'];
const attributes = ['Description', 'Scene', 'Camera #', 'Good Take', 'Comments', 'Keywords',
    'Identity', 'Project', 'Group', 'Camera', 'Quality'];
const legacyColumns = [...names, ...attributes];
const columns = [...names, 'Start TC', 'End TC', ...attributes];
// Resolve fails filename matching when ordinary values are unnecessarily quoted.
// Quote only fields that need CSV escaping, as in Resolve's own metadata export.
const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

// CSV fields may contain commas, escaped quotes, or embedded line breaks.
function readRows(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], cell = '', quoted = false, closed = false;
    const invalid = () => new Error('Export metadata CSV is invalid or has different columns. The file has been preserved.');
    const field = () => { row.push(cell); cell = ''; closed = false; if (row.length > columns.length) throw invalid(); };
    const record = () => { field(); rows.push(row); row = []; };
    const text = content.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (quoted) {
            if (character === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else { quoted = false; closed = true; }
            } else cell += character;
        } else if (character === ',') field();
        else if (character === '\r' || character === '\n') {
            record(); if (character === '\r' && text[i + 1] === '\n') i++;
        } else if (character === '"' && !cell && !closed) quoted = true;
        else {
            if (closed || character === '"') throw invalid();
            cell += character;
        }
    }
    if (quoted) throw invalid();
    if (row.length || cell || closed) record();
    const header = rows.shift();
    const legacy = JSON.stringify(header) === JSON.stringify(legacyColumns);
    if (!header || (!legacy && JSON.stringify(header) !== JSON.stringify(columns))) throw invalid();
    if (rows.some(row => row.length !== header.length || !row[0])) throw invalid();
    if (legacy) for (const row of rows) row.splice(names.length, 0, '', '');
    return rows;
}

export const resolveFormatter: ExportFormatter = {
    id: 'resolve',
    mediaFields: readResolveTimecode,
    clip(metadata, extension) {
        const originalExtension = extname(metadata.originalFilename);
        const originalStem = metadata.originalFilename.slice(0, metadata.originalFilename.length - originalExtension.length);
        const source = `${metadata.id}.${extension}`, proxy = `Proxy/${metadata.id}.mov`;
        const clipName = [metadata.identity, metadata.project, metadata.scene, metadata.camera, originalStem].filter(Boolean).join(' · ');
        const keywords = [...metadata.tags, ...(metadata.identity ? [`identity:${metadata.identity}`] : []),
            ...(metadata.project ? [`project:${metadata.project}`] : []), ...(metadata.rating ? [`rating:${metadata.rating}`] : [])];
        return { id: metadata.id, source, proxy,
            fields: { 'Clip Name': clipName, Description: metadata.scene, Scene: metadata.group, 'Camera #': metadata.camera,
                'Good Take': metadata.rating === 'preferred' ? '1' : metadata.rating !== null ? '0' : '', Comments: metadata.notes,
                Keywords: [...new Set(keywords)].join(', '), 'Identity': metadata.identity ?? '', 'Project': metadata.project ?? '',
                'Group': metadata.group, 'Camera': metadata.camera, 'Quality': metadata.rating ?? '' } };
    },
    manifest(clips, destination, existing) {
        const rows = new Map((existing === undefined ? [] : readRows(existing)).map(row => [row[0], row]));
        for (const clip of clips) rows.set(clip.source, columns.map(column => column === 'File Name' ? clip.source : column === 'Clip Directory' ? destination : clip.fields[column] ?? ''));
        return [columns, ...rows.values()].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    },
};
