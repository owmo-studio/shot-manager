import { useClipView } from "./ClipViewContext";
import { secondaryButton as button, primaryButton, dangerButton as destructiveButton } from "./buttonStyles";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../../shared/errors";
import type { IngestReview, IngestStatus } from "../../shared/ingestion";
import type { VideoShot } from "../../shared/shots";
import { ErrorDialog } from "./ErrorDialog";
import { CommitReviewDialog } from "./CommitReviewDialog";
import { ModalDialog } from "./ModalDialog";
import { hasPendingCommit } from "./clipState";

export function CommitControls({
    shots,
    selectedShotIds,
    connected,
    onRefresh,
    refreshTarget,
    catalogueRefreshing = false,
}: {
    shots: VideoShot[];
    selectedShotIds: string[];
    connected: boolean;
    onRefresh: () => Promise<void>;
    refreshTarget: HTMLDivElement | null;
    catalogueRefreshing?: boolean;
}) {
    const { api, mode } = useClipView();
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
        if (!connected || !api.getIngestStatus) return;
        let disposed = false;
        const receive = (next: IngestStatus) => {
            if (!disposed) receiveStatus(next);
        };
        // Subscribe before the initial read; revisions prevent a late read or mutation
        // response from replacing a newer notification. No idle or active polling.
        const unsubscribe = api.onIngestChanged(receive);
        void api
            .getIngestStatus()
            .then(receive)
            .catch(() => undefined);
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, [connected]);

    const selected = selectedShotIds.length > 0;
    const selectedIds = new Set(selectedShotIds);
    const scope = selected ? shots.filter(shot => selectedIds.has(shot.id)) : shots;
    const skipped = scope.filter((shot) => shot.organization?.skipped).length;
    const candidates = scope.filter(
        (shot) => mode === "library" ? shot.ingestState === "changes-pending" : !shot.organization?.skipped && shot.ingestState !== "synced" && !hasPendingCommit(shot),
    );
    const syncedCandidates = mode === 'import' && !selected ? shots.filter(shot => shot.ingestState === 'synced' && shot.editable && !shot.organization?.skipped) : [];
    const blocked = candidates.filter(
        (shot) => !shot.editable || mode === "import" && (!shot.available || !shot.hasThumbnail || shot.thumbnailStatus !== "ready"),
    ).length;

    async function openReview() {
        if (busy) return;
        setBusy(true);
        setError(null);
        setErrorTitle("Commit error");
        try {
            setReview(await api.reviewIngest([...candidates, ...syncedCandidates].map((shot) => shot.id), mode === 'import' && !selected));
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
            receiveStatus(await api.startIngest(review.token, ids));
            setReview(null);
            await onRefresh();
        } catch (reason) {
            setError(errorMessage(reason, "Could not queue clips for committing."));
            // A lost mutation response must not make the UI assume nothing was queued.
            const next = await api.getIngestStatus().catch(() => null);
            if (next) {
                receiveStatus(next);
                if (next.acceptedReviews?.includes(review.token)) {
                    setReview(null); setError(null); await onRefresh(); return;
                }
                // Existing transfers do not establish whether this appended submission succeeded.
                const collection = await api.getShots().catch(() => null);
                if (collection && ids.every(id => collection.shots.some(shot => shot.id === id &&
                    (hasPendingCommit(shot) || shot.ingestState === "synced")))) setReview(null);
            }
        } finally {
            setBusy(false);
        }
    }

    async function stop() {
        setBusy(true);
        setErrorTitle("Stop error");
        try {
            receiveStatus(await api.stopAllWork());
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
            const next = await api.refreshLibrary();
            receiveStatus(next);
            if (mode === "library") await api.refreshCatalogue();
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

    const checkingLibrary = status.libraryScan?.state === "checking" || catalogueRefreshing;
    const failure = status.errors[0];
    const hasWork = status.active || !!status.work?.busy;
    const tasks = status.tasks ?? { completed: 0, total: 0, percent: 0, proxiesRemaining: 0, transfersRemaining: 0 };
    const { proxiesRemaining: proxies, transfersRemaining: transfers } = tasks;
    const syncProgress = (tasks.syncsRemaining ?? 0) > 0 ? tasks.sync : undefined;
    const taskSummary = [
        proxies > 0 ? `${proxies} ${proxies === 1 ? "proxy" : "proxies"}` : null,
        transfers > 0 ? `${transfers} ${transfers === 1 ? "commit" : "commits"}` : null,
    ].filter(Boolean).join(", ");
    const activityLabel = [taskSummary, syncProgress ? `Sync ${syncProgress.completed}/${syncProgress.total}` : null].filter(Boolean).join(', ');
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
            {(proxies + transfers > 0 || syncProgress) && <div
                data-work-progress
                data-ingest-progress={status.active ? "" : undefined}
                role="status"
                aria-label={activityLabel}
                className="col-start-2 row-start-1 flex items-center gap-3 px-4 text-xs font-medium text-zinc-200 tabular-nums"
            >
                {taskSummary && <span className="flex items-center gap-2">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" className="size-3.5 shrink-0 text-zinc-400 motion-safe:animate-spin">
                    <circle cx="12" cy="12" r="8" opacity=".25" />
                    <path d="M12 4a8 8 0 0 1 8 8" />
                </svg>
                {taskSummary}
                </span>}
                {syncProgress && <div className="flex items-center gap-2" data-sync-progress>
                    <span className="whitespace-nowrap">Sync {syncProgress.completed}/{syncProgress.total}</span>
                    <div role="progressbar" aria-label="Sync progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={syncProgress.percent}
                        aria-valuetext={`${syncProgress.completed} of ${syncProgress.total} clips synced`}
                        className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-emerald-400 motion-safe:transition-[width]" style={{ width: `${syncProgress.percent}%` }} />
                    </div>
                </div>}
            </div>}
            <div className="col-start-3 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-2">
                <span role="status">
                    {candidates.length} {selected ? "selected " : ""}{candidates.length === 1 ? "clip" : "clips"} to commit{mode === "import" ? ` · ${skipped} skipped` : ""}
                    {syncedCandidates.length > 0 ? ` · ${syncedCandidates.length} synced` : ''}
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
                            checkingLibrary ||
                            (!candidates.length && !syncedCandidates.length) ||
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
                <CommitReviewDialog
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
                <ModalDialog titleId="ingest-dialog-title" title="Stop All Work?" width="w-[min(420px,90vw)]" busy={busy} onCancel={() => setStopConfirm(false)}>
                    <p className="mt-3 text-sm leading-6 text-zinc-400">Stop all queued and active Commits, Syncs, proxy encoding, and thumbnail generation?</p>
                    <p className="mt-2 text-xs text-zinc-500">Completed work is kept.</p>
                    <div className="mt-5 flex justify-end gap-3">
                        <button autoFocus disabled={busy} onClick={() => setStopConfirm(false)} className={button}>
                            Cancel
                        </button>
                        <button disabled={busy} onClick={() => void stop()} className={destructiveButton}>
                            {busy ? "Stopping…" : "Stop All"}
                        </button>
                    </div>
                </ModalDialog>
            )}
            {!review && !stopConfirm && error && (
                <ErrorDialog title={errorTitle} message={error} onDismiss={() => setError(null)} />
            )}
            {!review && !stopConfirm && !error && failure && (
                <ErrorDialog
                    title={failure.kind === "sync" ? "Sync failed" : "Commit failed"}
                    message={`${failure.filename}: ${failure.message}`}
                    onDismiss={() => {
                        void api
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
