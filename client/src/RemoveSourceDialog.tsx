import { useEffect, useRef } from "react";
import type { ImportSource } from "../../shared/desktop";
import { sourcePresentation } from "./SourceListItem";

export function RemoveSourceDialog({ source, removing, scanning, error, onCancel, onProceed }: {
    source: ImportSource;
    removing: boolean;
    scanning: boolean;
    error: string | null;
    onCancel: () => void;
    onProceed: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);

    return (
        <dialog
            ref={dialog}
            role="alertdialog"
            aria-labelledby="remove-source-title"
            aria-describedby="remove-source-description"
            onCancel={(event) => { event.preventDefault(); if (!removing) onCancel(); }}
            className="m-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60"
        >
            <h2 id="remove-source-title" className="text-lg font-medium">Remove source?</h2>
            <p className="mt-4 font-medium">{sourcePresentation(source).name}</p>
            <p id="remove-source-description" className="mt-2 text-sm leading-6 text-zinc-400">
                Removing this source will remove all of its clips and metadata from the current workspace. Files on disk will not be deleted.
            </p>
            {scanning && <p className="mt-3 text-xs text-blue-300">Wait for scanning to finish before removing this source.</p>}
            {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
                <button autoFocus onClick={onCancel} disabled={removing} className="rounded-lg border border-white/10 px-4 py-2 text-sm hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40">Cancel</button>
                <button onClick={onProceed} disabled={removing || scanning} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 disabled:opacity-40">{removing ? "Removing…" : "Proceed"}</button>
            </div>
        </dialog>
    );
}
