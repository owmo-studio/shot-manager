import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

// Native modal behavior shared by Commit review and clip/global Stop/Eject confirmations.
export function ModalDialog({ title, titleId, busy, onCancel, children, width = 'w-[min(760px,90vw)]' }: {
    title: string;
    titleId: string;
    busy: boolean;
    onCancel: () => void;
    children: ReactNode;
    width?: string;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    return <dialog ref={dialog} aria-labelledby={titleId}
        onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
        className={`m-auto ${width} rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60`}>
        <h2 id={titleId} className="text-lg font-medium">{title}</h2>
        {children}
    </dialog>;
}
