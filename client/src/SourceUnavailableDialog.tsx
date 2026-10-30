import { useEffect, useRef } from "react";
import type { ImportSource } from "../../shared/desktop";
import { sourcePresentation } from "./SourceListItem";

export function SourceUnavailableDialog({ source, onDismiss }: {
    source: ImportSource;
    onDismiss: () => void;
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
            aria-labelledby="source-unavailable-title"
            aria-describedby="source-unavailable-description"
            onCancel={(event) => { event.preventDefault(); onDismiss(); }}
            className="m-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60"
        >
            <h2 id="source-unavailable-title" className="text-lg font-medium">Source unavailable</h2>
            <p className="mt-4 font-medium">{sourcePresentation(source).name}</p>
            <p id="source-unavailable-description" className="mt-2 text-sm leading-6 text-zinc-400">
                {source.warning ?? "Source not found. It may have been disconnected, moved, or renamed. Please resolve to continue."}
            </p>
            <p className="mt-3 break-all text-xs text-zinc-500">{source.path}</p>
            <div className="mt-6 flex justify-end">
                <button autoFocus onClick={onDismiss} className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                    Dismiss
                </button>
            </div>
        </dialog>
    );
}
