import { useEffect, useRef } from "react";
import type { ImportSource } from "../../shared/desktop";
import { sourcePresentation } from "./SourceListItem";

export function SourceUnavailableDialog({ sources, onDismiss }: {
    sources: ImportSource[];
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
            <h2 id="source-unavailable-title" className="text-lg font-medium">{sources.length === 1 ? "Source unavailable" : "Sources unavailable"}</h2>
            <p id="source-unavailable-description" className="mt-3 text-sm leading-6 text-zinc-400">
                {sources.length === 1
                    ? "Source not found. It may have been disconnected, moved, or renamed. Please resolve to continue."
                    : "Sources not found. They may have been disconnected, moved, or renamed. Please resolve to continue."}
            </p>
            <ul aria-label="Unavailable sources" className="mt-4 max-h-64 space-y-3 overflow-y-auto pr-2">
                {sources.map((source) => <li key={source.id} className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                    <p className="font-medium text-red-200">{sourcePresentation(source).name}</p>
                    <p className="mt-1 break-all text-xs text-zinc-500">{source.path}</p>
                    {source.warning && !source.warning.startsWith("Source not found.") && <p className="mt-2 text-xs text-red-300">{source.warning}</p>}
                </li>)}
            </ul>
            <div className="mt-6 flex justify-end">
                <button autoFocus onClick={onDismiss} className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                    Dismiss
                </button>
            </div>
        </dialog>
    );
}
