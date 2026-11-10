import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../../shared/errors";
import type { IngestReview, IngestStatus } from "../../shared/ingestion";
import type { VideoShot } from "../../shared/shots";
import { SourceErrorDialog } from "./SourceErrorDialog";

const buttonBase = "rounded-md border px-3 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed";
const button = `${buttonBase} border-white/15 text-zinc-200 hover:bg-white/8`;
const primaryButton = `${buttonBase} border-blue-500 bg-blue-500 text-white hover:bg-blue-400 disabled:hover:bg-blue-500`;
const destructiveButton = `${buttonBase} border-red-500/60 bg-red-600 text-white hover:bg-red-500 disabled:hover:bg-red-600`;
const bytes = (value: number) =>
    value >= 1e9
        ? `${(value / 1e9).toFixed(1)} GB`
        : value >= 1e6
          ? `${(value / 1e6).toFixed(1)} MB`
          : `${Math.max(1, Math.round(value / 1000))} KB`;

function IngestDialog({
    title,
    busy,
    onCancel,
    children,
    compact = false,
}: {
    title: string;
    busy: boolean;
    onCancel: () => void;
    children: ReactNode;
    compact?: boolean;
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
            aria-labelledby="ingest-dialog-title"
            onCancel={(event) => {
                event.preventDefault();
                if (!busy) onCancel();
            }}
            className={`m-auto ${compact ? "w-[min(420px,90vw)]" : "w-[min(760px,90vw)]"} rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60`}
        >
            <h2 id="ingest-dialog-title" className="text-lg font-medium">
                {title}
            </h2>
            {children}
        </dialog>
    );
}

function ReviewDialog({
    review,
    busy,
    error,
    onCancel,
    onStart,
}: {
    review: IngestReview;
    busy: boolean;
    error: string | null;
    onCancel: () => void;
    onStart: (ids: string[]) => void;
}) {
    const [ids, setIds] = useState(review.clips.map((clip) => clip.id));
    const clips = review.clips.filter((clip) => ids.includes(clip.id));
    const replacements = clips.filter((clip) => clip.mode === "replace").length;
    return (
        <IngestDialog title="Ready to Process?" busy={busy} onCancel={onCancel}>
            <p className="mt-3 text-sm text-zinc-400">
                {clips.length} {clips.length === 1 ? "clip" : "clips"} ·{" "}
                {bytes(clips.reduce((sum, clip) => sum + clip.bytes, 0))}
            </p>
            <p className="mt-2 break-all text-xs text-zinc-500">{review.libraryPath}</p>
            <div className="mt-4 max-h-[45vh] overflow-y-auto rounded-lg border border-white/10">
                {clips.map((clip) => (
                    <div key={clip.id} className="flex items-start gap-3 border-b border-white/8 p-3 last:border-0">
                        <span
                            className={`mt-0.5 rounded px-2 py-0.5 text-xs ${clip.mode === "replace" ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300"}`}
                        >
                            {clip.mode === "replace" ? "↻ Update" : "+ New"}
                        </span>
                        <div className="min-w-0 flex-1 text-sm">
                            <p className="break-all">
                                {clip.filename} <span className="text-xs text-zinc-500">{bytes(clip.bytes)}</span>
                            </p>
                            <details className="mt-1 text-xs text-zinc-500">
                                <summary className="cursor-pointer">File destinations</summary>
                                {clip.files.map((file) => (
                                    <p key={file.to} className="mt-2 break-all">
                                        {file.from}
                                        <br />→ {file.to}
                                    </p>
                                ))}
                            </details>
                        </div>
                        <button
                            disabled={busy}
                            onClick={() => setIds((current) => current.filter((id) => id !== clip.id))}
                            aria-label={`Remove ${clip.filename} from review`}
                            className={button}
                        >
                            ×
                        </button>
                    </div>
                ))}
                {!clips.length && <p className="p-4 text-sm text-zinc-500">No clips remaining.</p>}
            </div>
            {replacements > 0 && (
                <p className="mt-3 text-sm text-amber-300">
                    Processing will update the Library source, thumbnail, and metadata for {replacements}{" "}
                    {replacements === 1 ? "clip" : "clips"}. Additional assets are preserved.
                </p>
            )}
            {error && (
                <p role="alert" className="mt-3 text-sm text-red-300">
                    {error}
                </p>
            )}
            <div className="mt-5 flex justify-end gap-3">
                <button autoFocus disabled={busy} onClick={onCancel} className={button}>
                    Cancel
                </button>
                <button
                    disabled={busy || !clips.length}
                    onClick={() => onStart(ids)}
                    className={`${button} bg-blue-500/30`}
                >
                    {busy ? "Queueing…" : "Process"}
                </button>
            </div>
        </IngestDialog>
    );
}

export function IngestFooter({
    shots,
    connected,
    onRefresh,
    refreshTarget,
}: {
    shots: VideoShot[];
    connected: boolean;
    onRefresh: () => Promise<void>;
    refreshTarget: HTMLDivElement | null;
}) {
    const [status, setStatus] = useState<IngestStatus>({
        revision: 0,
        active: false,
        stopping: false,
        position: 0,
        total: 0,
        errors: [],
    });
    const [review, setReview] = useState<IngestReview | null>(null);
    const [stopConfirm, setStopConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    function receiveStatus(next: IngestStatus) {
        setStatus((current) => (next.revision >= current.revision ? next : current));
    }
    useEffect(() => {
        if (!connected || !window.desktop.getIngestStatus) return;
        let disposed = false;
        const receive = (next: IngestStatus) => {
            if (!disposed) receiveStatus(next);
        };
        // Subscribe before the initial read; revisions prevent a late read or mutation
        // response from replacing a newer notification. No idle or active polling.
        const unsubscribe = window.desktop.onIngestChanged(receive);
        void window.desktop
            .getIngestStatus()
            .then(receive)
            .catch(() => undefined);
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, [connected]);

    const skipped = shots.filter((shot) => shot.organization?.skipped).length;
    const candidates = shots.filter(
        (shot) => !shot.organization?.skipped && !["synced", "queued", "processing"].includes(shot.ingestState ?? ""),
    );
    const blocked = candidates.filter(
        (shot) => !shot.available || !shot.editable || !shot.hasThumbnail || shot.thumbnailStatus !== "ready",
    ).length;

    async function openReview() {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            setReview(await window.desktop.reviewIngest(candidates.map((shot) => shot.id)));
        } catch (reason) {
            setError(errorMessage(reason, "Could not prepare processing."));
        } finally {
            setBusy(false);
        }
    }

    async function start(ids: string[]) {
        if (!review || busy) return;
        setBusy(true);
        setError(null);
        try {
            receiveStatus(await window.desktop.startIngest(review.token, ids));
            setReview(null);
            await onRefresh();
        } catch (reason) {
            setError(errorMessage(reason, "Could not queue clips for processing."));
            // A lost mutation response must not make the UI assume nothing was queued.
            const next = await window.desktop.getIngestStatus().catch(() => null);
            if (next) {
                receiveStatus(next);
                if (next.active) setReview(null);
            }
        } finally {
            setBusy(false);
        }
    }

    async function stop() {
        setBusy(true);
        try {
            receiveStatus(await window.desktop.stopIngest());
            setStopConfirm(false);
            await onRefresh();
        } catch (reason) {
            setStopConfirm(false);
            setError(errorMessage(reason, "Could not stop the queue."));
        } finally {
            setBusy(false);
        }
    }

    async function refreshLibrary() {
        setBusy(true);
        try {
            const next = await window.desktop.refreshLibrary();
            receiveStatus(next);
            await onRefresh();
            if (next.libraryScan?.state === "unavailable") setError(next.libraryScan.error ?? "Library unavailable.");
        } catch (reason) {
            setError(errorMessage(reason, "Could not check the Library."));
        } finally {
            setBusy(false);
        }
    }

    const checkingLibrary = status.libraryScan?.state === "checking";
    const failure = status.errors[0];
    return (
        <>
            {refreshTarget &&
                createPortal(
                    <button
                        type="button"
                        aria-label="Refresh Library"
                        aria-busy={checkingLibrary}
                        title={
                            checkingLibrary
                                ? "Checking Library…"
                                : status.libraryScan?.state === "unavailable"
                                  ? `Refresh Library: ${status.libraryScan.error ?? "Library unavailable"}`
                                  : "Refresh Library"
                        }
                        disabled={busy || !connected || !status.libraryPath || status.active || checkingLibrary}
                        onClick={() => void refreshLibrary()}
                        className={`grid size-8 shrink-0 place-items-center rounded-md transition enabled:hover:bg-white/8 enabled:hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40 ${checkingLibrary ? "disabled:cursor-wait" : "disabled:cursor-not-allowed"} ${status.libraryScan?.state === "unavailable" ? "text-amber-400" : "text-zinc-400"}`}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            className={`size-5 ${checkingLibrary ? "motion-safe:animate-spin" : ""}`}
                        >
                            <path d="M3 11a9 9 0 0 1 15.36-6.36L21 7M21 3v4h-4M21 13a9 9 0 0 1-15.36 6.36L3 17M7 17H3v4" />
                        </svg>
                    </button>,
                    refreshTarget,
                )}
            {status.active && (
                <div
                    data-ingest-progress
                    role="status"
                    aria-label={
                        status.stopping ? "Stopping queue" : `${status.position} / ${status.total} clips processing`
                    }
                    className="col-start-2 row-start-1 flex w-[clamp(18rem,32vw,30rem)] items-center gap-3 px-4"
                >
                    <span className="shrink-0 text-xs font-medium leading-4 text-zinc-200 tabular-nums">
                        {status.position} / {status.total}
                    </span>
                    <progress
                        aria-label={
                            status.stopping
                                ? "Stopping queue"
                                : status.current?.phase === "metadata"
                                  ? "Saving metadata"
                                  : status.current ? `Processing ${status.current.filename}` : "Preparing clips"
                        }
                        className="ingest-progress block h-2.5 min-w-0 flex-1"
                        max={100}
                        value={status.current?.percent ?? 0}
                    />
                    <span className="shrink-0 text-xs font-medium leading-4 text-emerald-300 tabular-nums">
                        {status.current?.percent ?? 0}%
                    </span>
                    <button
                        type="button"
                        aria-label="Stop Queue"
                        title="Stop Queue"
                        onClick={() => setStopConfirm(true)}
                        disabled={busy || status.stopping}
                        className="grid size-5 shrink-0 place-items-center rounded-full text-zinc-400 transition enabled:hover:bg-red-500/10 enabled:hover:text-red-400 enabled:active:bg-red-500/20 enabled:active:text-red-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-3" aria-hidden="true">
                            <path d="m6 6 12 12M18 6 6 18" />
                        </svg>
                    </button>
                </div>
            )}
            {!status.active && status.libraryScan?.state === "unavailable" && (
                <span
                    role="status"
                    title={status.libraryScan.error}
                    className="col-start-2 row-start-1 text-xs text-amber-300"
                >
                    Library unavailable
                </span>
            )}
            <div className="col-start-3 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-2">
                {!status.active && (
                    <span role="status">
                        {candidates.length} {candidates.length === 1 ? "clip" : "clips"} to process · {skipped} skipped
                        {blocked ? ` · ${blocked} not ready` : ""}
                    </span>
                )}
                <div className="flex shrink-0 items-center gap-3">
                    <button
                        onClick={() => void openReview()}
                        disabled={
                            !connected ||
                            busy ||
                            status.active ||
                            !status.libraryPath ||
                            status.libraryScan?.state !== "ready" ||
                            !candidates.length ||
                            blocked > 0
                        }
                        title={
                            !status.libraryPath
                                ? "Set a Library location in Configuration"
                                : blocked
                                  ? "Each clip needs an available source and a ready thumbnail"
                                  : undefined
                        }
                        className={primaryButton}
                    >
                        Process
                    </button>
                </div>
            </div>
            {review && (
                <ReviewDialog
                    review={review}
                    busy={busy}
                    error={error}
                    onCancel={() => {
                        setReview(null);
                        setError(null);
                    }}
                    onStart={(ids) => void start(ids)}
                />
            )}
            {stopConfirm && (
                <IngestDialog title="Stop Queue?" compact busy={busy} onCancel={() => setStopConfirm(false)}>
                    <p className="mt-3 text-sm text-zinc-400">
                        Cancel waiting clips and stop the active transfer?
                        <br />
                        Completed clips remain synced.
                    </p>
                    <div className="mt-5 flex justify-end gap-3">
                        <button autoFocus disabled={busy} onClick={() => setStopConfirm(false)} className={button}>
                            Cancel
                        </button>
                        <button disabled={busy} onClick={() => void stop()} className={destructiveButton}>
                            {busy ? "Stopping…" : "Stop"}
                        </button>
                    </div>
                </IngestDialog>
            )}
            {!review && !stopConfirm && error && (
                <SourceErrorDialog title="Processing error" message={error} onDismiss={() => setError(null)} />
            )}
            {!review && !stopConfirm && !error && failure && (
                <SourceErrorDialog
                    title="Processing failed"
                    message={`${failure.filename}: ${failure.message}`}
                    onDismiss={() => {
                        void window.desktop
                            .dismissIngestError(failure.eventId)
                            .then(() =>
                                setStatus((current) => ({
                                    ...current,
                                    errors: current.errors.filter((item) => item.eventId !== failure.eventId),
                                })),
                            )
                            .catch((reason) => setError(errorMessage(reason, "Could not dismiss the error.")));
                    }}
                />
            )}
        </>
    );
}
