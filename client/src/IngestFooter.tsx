import { secondaryButton as button, primaryButton, dangerButton as destructiveButton } from "./buttonStyles";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../../shared/errors";
import type { IngestReview, IngestStatus } from "../../shared/ingestion";
import type { VideoShot } from "../../shared/shots";
import { SourceErrorDialog } from "./SourceErrorDialog";

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
    shots,
    busy,
    error,
    onCancel,
    onStart,
}: {
    review: IngestReview;
    shots: VideoShot[];
    busy: boolean;
    error: string | null;
    onCancel: () => void;
    onStart: (ids: string[]) => void;
}) {
    const [ids, setIds] = useState(review.clips.map((clip) => clip.id));
    const clips = review.clips.filter((clip) => ids.includes(clip.id));
    const replacements = clips.filter((clip) => clip.mode === "replace").length;
    return (
        <IngestDialog title="Ready to Commit?" busy={busy} onCancel={onCancel}>
            <p className="mt-3 text-sm text-zinc-400">
                {clips.length} {clips.length === 1 ? "clip" : "clips"} ·{" "}
                {bytes(clips.reduce((sum, clip) => sum + clip.bytes, 0))}
                {review.proxyPreparation && (
                    <span className="ml-1 text-xs text-zinc-500">excl. proxies</span>
                )}
            </p>
            <p className="mt-2 break-all text-xs text-zinc-500">{review.libraryPath}</p>
            <div className="mt-4 max-h-[45vh] overflow-y-auto rounded-lg border border-white/10">
                {review.clips.map((clip) => {
                    const included = ids.includes(clip.id);
                    const proxyReady =
                        clip.proxyReady || shots.some((shot) => shot.id === clip.id && shot.proxyState === "ready");
                    return (
                        <div
                            key={clip.id}
                            data-review-included={included}
                            className={`flex items-start gap-3 border-b border-white/8 p-3 last:border-0 ${included ? "" : "bg-white/[0.02]"}`}
                        >
                            <div
                                className={`mt-0.5 flex shrink-0 flex-col items-start gap-1 ${included ? "" : "opacity-40"}`}
                            >
                                <span className="rounded bg-blue-400/10 px-2 py-0.5 text-xs text-blue-300">
                                    {clip.mode === "replace" ? "↻ Update" : "New"}
                                </span>
                                {review.proxyPreparation && proxyReady && (
                                    <span
                                        data-review-proxy-ready="true"
                                        title="Proxy available"
                                        className="rounded bg-blue-400/10 px-2 py-0.5 text-xs text-blue-300"
                                    >
                                        Proxy
                                    </span>
                                )}
                            </div>
                            <div className={`min-w-0 flex-1 text-sm ${included ? "" : "opacity-40"}`}>
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
                                onClick={() =>
                                    setIds((current) =>
                                        current.includes(clip.id)
                                            ? current.filter((id) => id !== clip.id)
                                            : [...current, clip.id],
                                    )
                                }
                                aria-label={`${included ? "Remove" : "Restore"} ${clip.filename} ${included ? "from" : "to"} review`}
                                aria-pressed={!included}
                                className="grid size-7 shrink-0 place-items-center rounded text-2xl leading-none text-zinc-400 hover:bg-white/8 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                {included ? "×" : "−"}
                            </button>
                        </div>
                    );
                })}
            </div>
            {replacements > 0 && (
                <p className="mt-3 text-sm text-amber-300">
                    Updates {replacements} existing Library {replacements === 1 ? "clip" : "clips"}.
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
                    className={primaryButton}
                >
                    {busy ? "Queueing…" : "Commit"}
                </button>
            </div>
        </IngestDialog>
    );
}

export function IngestFooter({
    shots,
    selectedShotIds,
    connected,
    onRefresh,
    refreshTarget,
}: {
    shots: VideoShot[];
    selectedShotIds: string[];
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
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorTitle, setErrorTitle] = useState("Commit error");
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

    const selected = selectedShotIds.length > 0;
    const scope = selected ? shots.filter(shot => selectedShotIds.includes(shot.id)) : shots;
    const skipped = scope.filter((shot) => shot.organization?.skipped).length;
    const candidates = scope.filter(
        (shot) => !shot.organization?.skipped && !["synced", "queued", "processing"].includes(shot.ingestState ?? ""),
    );
    const blocked = candidates.filter(
        (shot) => !shot.available || !shot.editable || !shot.hasThumbnail || shot.thumbnailStatus !== "ready",
    ).length;

    async function openReview() {
        if (busy) return;
        setBusy(true);
        setError(null);
        setErrorTitle("Commit error");
        try {
            setReview(await window.desktop.reviewIngest(candidates.map((shot) => shot.id)));
        } catch (reason) {
            setError(errorMessage(reason, "Could not prepare the commit."));
        } finally {
            setBusy(false);
        }
    }

    async function start(ids: string[]) {
        if (!review || busy) return;
        setBusy(true);
        setError(null);
        setErrorTitle("Commit error");
        try {
            receiveStatus(await window.desktop.startIngest(review.token, ids));
            setReview(null);
            await onRefresh();
        } catch (reason) {
            setError(errorMessage(reason, "Could not queue clips for committing."));
            // A lost mutation response must not make the UI assume nothing was queued.
            const next = await window.desktop.getIngestStatus().catch(() => null);
            if (next) {
                receiveStatus(next);
                // Existing transfers do not establish whether this appended submission succeeded.
                const collection = await window.desktop.getShots().catch(() => null);
                if (collection && ids.every(id => collection.shots.some(shot => shot.id === id &&
                    ["queued", "processing", "synced"].includes(shot.ingestState ?? "")))) setReview(null);
            }
        } finally {
            setBusy(false);
        }
    }

    async function stop() {
        setBusy(true);
        setErrorTitle("Stop error");
        try {
            receiveStatus(await window.desktop.stopAllWork());
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
        setRefreshing(true);
        setError(null);
        setErrorTitle("Refresh error");
        try {
            const next = await window.desktop.refreshLibrary();
            receiveStatus(next);
            await onRefresh();
            if (next.libraryScan?.state === "unavailable") {
                setErrorTitle("Library unavailable");
                setError(
                    next.libraryScan.error ??
                        "The configured Library folder is unavailable. Check its location in Configuration.",
                );
            }
        } catch (reason) {
            setError(errorMessage(reason, "Could not refresh assets."));
        } finally {
            setRefreshing(false);
        }
    }

    const checkingLibrary = status.libraryScan?.state === "checking";
    const failure = status.errors[0];
    const hasWork = status.active || !!status.work?.busy;
    const tasks = status.tasks ?? { completed: 0, total: 0, percent: 0, proxiesRemaining: 0, transfersRemaining: 0 };
    const { proxiesRemaining: proxies, transfersRemaining: transfers } = tasks;
    const taskSummary = [
        proxies > 0 ? `${proxies} ${proxies === 1 ? "proxy" : "proxies"}` : null,
        transfers > 0 ? `${transfers} ${transfers === 1 ? "commit" : "commits"}` : null,
    ].filter(Boolean).join(", ");
    return (
        <>
            {refreshTarget &&
                createPortal(
                    <button
                        type="button"
                        aria-label={hasWork ? "Stop all work" : "Refresh assets"}
                        aria-busy={checkingLibrary || refreshing || status.stopping}
                        title={
                            hasWork
                                ? "Work in progress · Stop all work"
                                : checkingLibrary || refreshing
                                  ? "Checking assets…"
                                  : "Refresh assets and resume background work"
                        }
                        disabled={
                            busy ||
                            !connected ||
                            status.stopping ||
                            (!hasWork && (!status.libraryPath || checkingLibrary || refreshing))
                        }
                        onClick={() => (hasWork ? setStopConfirm(true) : void refreshLibrary())}
                        className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-400 transition enabled:hover:bg-white/8 enabled:hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {hasWork ? (
                            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="size-5">
                                <rect x="6" y="6" width="12" height="12" rx="1" />
                            </svg>
                        ) : (
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                                className="size-5"
                            >
                                <path d="M3 11a9 9 0 0 1 15.36-6.36L21 7M21 3v4h-4M21 13a9 9 0 0 1-15.36 6.36L3 17M7 17H3v4" />
                            </svg>
                        )}
                    </button>,
                    refreshTarget,
                )}
            {proxies + transfers > 0 && <div
                data-work-progress
                data-ingest-progress={status.active ? "" : undefined}
                role="status"
                aria-label={taskSummary}
                className="col-start-2 row-start-1 flex items-center gap-2 px-4 text-xs font-medium text-zinc-200 tabular-nums"
            >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" className="size-3.5 shrink-0 text-zinc-400 motion-safe:animate-spin">
                    <circle cx="12" cy="12" r="8" opacity=".25" />
                    <path d="M12 4a8 8 0 0 1 8 8" />
                </svg>
                {taskSummary}
            </div>}
            <div className="col-start-3 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-2">
                <span role="status">
                    {candidates.length} {selected ? "selected " : ""}{candidates.length === 1 ? "clip" : "clips"} to commit · {skipped} skipped
                    {blocked ? ` · ${blocked} not ready` : ""}
                </span>
                <div className="flex shrink-0 items-center gap-3">
                    <button
                        onClick={() => void openReview()}
                        disabled={
                            !connected ||
                            busy ||
                            refreshing ||
                            !status.libraryPath ||
                            status.libraryScan?.state === "checking" ||
                            !candidates.length ||
                            blocked > 0
                        }
                        title={
                            !status.libraryPath
                                ? "Set a Library location in Configuration"
                                : blocked
                                  ? "Each clip needs an available source and a ready thumbnail"
                                  : selected && !candidates.length
                                    ? "No selected clips need committing"
                                    : selected ? "Commit eligible selected clips" : "Commit all eligible clips"
                        }
                        className={primaryButton}
                    >
                        Commit
                    </button>
                </div>
            </div>
            {review && (
                <ReviewDialog
                    review={review}
                    shots={shots}
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
                <IngestDialog title="Stop All Work?" compact busy={busy} onCancel={() => setStopConfirm(false)}>
                    <p className="mt-3 text-sm leading-6 text-zinc-400">Stop all queued and active Commits, proxy encoding, and thumbnail generation?</p>
                    <p className="mt-2 text-xs text-zinc-500">Completed work is kept.</p>
                    <div className="mt-5 flex justify-end gap-3">
                        <button autoFocus disabled={busy} onClick={() => setStopConfirm(false)} className={button}>
                            Cancel
                        </button>
                        <button disabled={busy} onClick={() => void stop()} className={destructiveButton}>
                            {busy ? "Stopping…" : "Stop All"}
                        </button>
                    </div>
                </IngestDialog>
            )}
            {!review && !stopConfirm && error && (
                <SourceErrorDialog title={errorTitle} message={error} onDismiss={() => setError(null)} />
            )}
            {!review && !stopConfirm && !error && failure && (
                <SourceErrorDialog
                    title="Commit failed"
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
