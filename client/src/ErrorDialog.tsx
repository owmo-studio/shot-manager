import { secondaryButton } from "./buttonStyles";
import { useEffect, useRef } from "react";

export function ErrorDialog({ message, onDismiss, title = "Workspace error" }: {
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
            <h2 id="source-error-title" className="text-lg font-medium text-red-300">{title}</h2>
            <p id="source-error-description" className="mt-3 text-sm leading-6 break-words whitespace-pre-wrap text-zinc-400">{message}</p>
            <div className="mt-6 flex justify-end">
                <button autoFocus onClick={onDismiss} className={secondaryButton}>
                    Dismiss
                </button>
            </div>
        </dialog>
    );
}
