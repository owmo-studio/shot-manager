import { useEffect, useRef } from 'react';
import type { OptionRemovalPlan } from '../../shared/organization';

export function RemoveOptionsDialog({ plan, busy, onCancel, onConfirm }: {
    plan: OptionRemovalPlan; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    return <dialog ref={dialog} role="alertdialog" aria-labelledby="remove-options-title"
        onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }}
        className="m-auto w-[640px] max-w-[calc(100vw-48px)] rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60">
        <h2 id="remove-options-title" className="text-lg font-medium">Removing Clip Attributes</h2>
        <p className="mt-3 text-sm text-zinc-400">{plan.clips.length.toLocaleString()} {plan.clips.length === 1 ? 'clip will' : 'clips will'} be affected.</p>
        <div className="mt-4 max-h-[45vh] overflow-auto rounded-lg border border-white/10">
            <table aria-label="Clips affected by removal" className="w-full table-fixed text-left text-xs">
                <thead className="sticky top-0 bg-[#1b2029] text-zinc-400"><tr><th className="w-1/2 p-3 font-medium">Clip</th><th className="w-1/2 p-3 font-medium">Metadata to Remove</th></tr></thead>
                <tbody>{plan.clips.map(clip => <tr key={clip.key} className="border-t border-white/5 align-top">
                    <td title={clip.path} className="break-all p-3 text-zinc-300"><span className="flex items-start gap-2">
                        <span title={clip.status === 'active' ? 'Active: loaded in the workspace' : 'Saved: local record from a previous session'}
                            aria-label={clip.status === 'active' ? 'Active clip' : 'Saved clip'} className="mt-0.5 shrink-0 text-zinc-500">
                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-3.5" aria-hidden="true">
                                {clip.status === 'active' ? <><rect x="2" y="3" width="16" height="11" rx="2" /><path d="M6 17h8M10 14v3" /></> : <><path d="M4 2h8l4 4v12H4zM12 2v5h4M7 11h6M7 14h6" /></>}
                            </svg>
                        </span><span>{clip.name}</span>
                    </span></td>
                    <td className="break-words p-3 text-zinc-400">
                        {clip.removals.identity.length > 0 && <div>Identity: {clip.removals.identity.join(', ')}</div>}
                        {clip.removals.project.length > 0 && <div>Project: {clip.removals.project.join(', ')}</div>}
                    </td>
                </tr>)}</tbody>
            </table>
        </div>
        <div className="mt-6 flex justify-end gap-3">
            <button autoFocus type="button" disabled={busy} onClick={onCancel} className="rounded-md border border-white/10 px-3 py-2 text-xs hover:bg-white/8 disabled:opacity-40">Cancel</button>
            <button type="button" aria-label="Confirm remove saved values" disabled={busy} onClick={onConfirm}
                className="rounded-md bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-40">{busy ? 'Removing…' : 'Remove'}</button>
        </div>
    </dialog>;
}
