import { useEffect, useRef } from "react";

export function SourceErrorDialog({ message, onDismiss, title = "Source error" }: {
    title?: string;
    message: string;
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
            aria-labelledby="source-error-title"
            aria-describedby="source-error-description"
            onCancel={(event) => { event.preventDefault(); onDismiss(); }}
            className="m-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60"
        >
            <h2 id="source-error-title" className="text-lg font-medium">{title}</h2>
            <p id="source-error-description" className="mt-3 text-sm leading-6 text-zinc-400">{message}</p>
            <div className="mt-6 flex justify-end">
                <button autoFocus onClick={onDismiss} className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400">
                    Dismiss
                </button>
            </div>
        </dialog>
    );
}
