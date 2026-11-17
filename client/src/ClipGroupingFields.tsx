import { useEffect, useState } from 'react';
import type { VideoShot } from '../../shared/shots';
import type { OrganizationAction } from '../../shared/organization';
import { GROUPING_MAX_LENGTH, normalizeGroupingText } from '../../shared/organization';
import { libraryAttributeChanged } from './libraryDiff';

const inputStyle = 'mt-1.5 block h-9 w-full min-w-0 rounded-lg border border-white/10 bg-black/10 px-3 text-xs text-zinc-200 outline-none focus:border-blue-400/50 placeholder:text-zinc-600';
const fields = ['group', 'camera', 'rating'] as const;

export function ClipGroupingFields({ shots, pending, failure, submit, onInvalid, flush }: {
    shots: VideoShot[]; pending: number; failure: string | null; submit: (action: OrganizationAction) => void;
    onInvalid: (message: string) => void; flush: () => void;
}) {
    const saved = JSON.stringify(fields.map(field => shots.map(shot => shot.organization?.[field] ?? '')));
    const common = (values: string[]) => values.every(value => value === values[0]) ? values[0] ?? '' : '';
    const initial: string[][] = JSON.parse(saved);
    const [group, setGroup] = useState(() => common(initial[0]));
    const [camera, setCamera] = useState(() => common(initial[1]));
    const [rating, setRating] = useState(() => new Set(initial[2]).size > 1 ? 'mixed' : common(initial[2]));
    useEffect(() => {
        if (pending || failure || document.activeElement?.matches('[aria-label="Group"], [aria-label="Camera"], [aria-label="Quality"]')) return;
        const values: string[][] = JSON.parse(saved);
        setGroup(common(values[0])); setCamera(common(values[1]));
        setRating(new Set(values[2]).size > 1 ? 'mixed' : common(values[2]));
    }, [saved, pending, failure]);

    return <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3" data-clip-grouping>
        {(['group', 'camera'] as const).map((field, index) => {
            const value = field === 'group' ? group : camera, set = field === 'group' ? setGroup : setCamera;
            const label = field === 'group' ? 'Group' : 'Camera';
            const changed = libraryAttributeChanged(shots, field);
            return <div key={field} data-attribute-field={field} data-library-diff={changed ? 'true' : undefined} className={`block min-w-0 text-xs text-zinc-400${changed ? ' rounded-md p-1 -m-1 ring-1 ring-amber-400/50 bg-amber-400/5' : ''}`}>
                <span className="attribute-label">{label}</span>
                <input aria-label={label} type="text" autoComplete="off" maxLength={GROUPING_MAX_LENGTH} value={value}
                    placeholder={new Set(initial[index]).size > 1 ? 'Mixed' : ''} className={inputStyle}
                    onBlur={() => { try { set(normalizeGroupingText(value)); } catch { /* The shared save error remains visible. */ } flush(); }}
                    onChange={event => {
                        set(event.target.value);
                        try { submit({ field, operation: 'set', value: normalizeGroupingText(event.target.value) }); }
                        catch (error) { onInvalid((error as Error).message); }
                    }} />
            </div>;
        })}
        <div data-attribute-field="rating" data-library-diff={libraryAttributeChanged(shots, 'rating') ? 'true' : undefined} className={`block min-w-0 text-xs text-zinc-400${libraryAttributeChanged(shots, 'rating') ? ' rounded-md p-1 -m-1 ring-1 ring-amber-400/50 bg-amber-400/5' : ''}`}>
            <span className="attribute-label">Quality</span>
            <select aria-label="Quality" value={rating} className={inputStyle}
                onChange={event => { setRating(event.target.value); submit({ field: 'rating', operation: 'set', value: event.target.value }); }}>
                <option value=""></option>
                {rating === 'mixed' && <option value="mixed" disabled>Mixed</option>}
                <option value="preferred">Preferred</option>
                <option value="usable">Usable</option>
            </select>
        </div>
    </div>;
}
