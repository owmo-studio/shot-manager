import { useClipView } from "./ClipViewContext";
import { secondaryButton as button, primaryButton, dangerButton as destructiveButton } from "./buttonStyles";
import { useState } from "react";
import { errorMessage } from "../../shared/errors";
import type { IngestReview, IngestStatus } from "../../shared/ingestion";
import type { VideoShot } from "../../shared/shots";
import { ErrorDialog } from "./ErrorDialog";
import { CommitReviewDialog } from "./CommitReviewDialog";
import { ModalDialog } from "./ModalDialog";
import { hasPendingCommit } from "./clipState";
import { WorkActivity } from "./WorkActivity";

export function CommitControls({
    shots,
    selectedShotIds,
    connected,
    status,
    receiveStatus,
    dismissError,
    onRefresh,
    workControlTarget,
    catalogueRefreshing = false,
}: {
    shots: VideoShot[];
    selectedShotIds: string[];
    connected: boolean;
    status: IngestStatus;
    receiveStatus: (status: IngestStatus) => void;
    dismissError: (eventId: string) => void;
    onRefresh: () => Promise<void>;
    workControlTarget: HTMLDivElement | null;
    catalogueRefreshing?: boolean;
}) {
    const { api, mode } = useClipView();
    const [review, setReview] = useState<IngestReview | null>(null);
    const [stopConfirm, setStopConfirm] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorTitle, setErrorTitle] = useState("Commit error");

    const selected = selectedShotIds.length > 0;
    const selectedIds = new Set(selectedShotIds);
    const scope = selected ? shots.filter(shot => selectedIds.has(shot.id)) : shots;
    const skipped = mode === 'import' ? scope.filter((shot) => shot.organization?.skipped).length : 0;
    const candidates = scope.filter(
        (shot) => mode === "library" ? shot.ingestState === "changes-pending" : !shot.organization?.skipped && shot.ingestState !== "synced" && !hasPendingCommit(shot),
    );
    const syncedCandidates = mode === 'import' ? scope.filter(shot => shot.ingestState === 'synced' && shot.editable && !shot.organization?.skipped) : [];
    const blocked = candidates.filter(
        (shot) => !shot.editable || mode === "import" && (!shot.available || !shot.hasThumbnail || shot.thumbnailStatus !== "ready"),
    ).length;

    async function openReview() {
        if (busy) return;
        setBusy(true);
        setError(null);
        setErrorTitle("Commit error");
        try {
            setReview(await api.reviewIngest([...candidates, ...syncedCandidates].map((shot) => shot.id), mode === 'import'));
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
    return (
        <>
            <WorkActivity status={status} controlTarget={workControlTarget} disabled={busy || !connected} checking={checkingLibrary || refreshing}
                onRefresh={() => void refreshLibrary()} onStop={() => setStopConfirm(true)} />
            <div className="col-start-3 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-2">
                <span role="status" aria-label="Clip selection summary">
                    {scope.length} {scope.length === 1 ? "clip" : "clips"} {selected ? "selected" : "total"}
                    {skipped > 0 ? ` (${skipped} skipped)` : ""}
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
                                  : selected && !candidates.length && !syncedCandidates.length
                                    ? "No selected clips need committing"
                                    : selected ? "Commit eligible selected clips" : "Commit eligible visible clips"
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
                <ModalDialog titleId="ingest-dialog-title" title="Stop Processing?" width="w-[min(420px,90vw)]" busy={busy} onCancel={() => setStopConfirm(false)}>
                    <p className="mt-3 text-sm leading-6 text-zinc-400">Stop all queued and active Commits, Exports, and proxy encoding?</p>
                    <p className="mt-2 text-xs text-zinc-500">Thumbnails will continue. Completed work is kept.</p>
                    <div className="mt-5 flex justify-end gap-3">
                        <button autoFocus disabled={busy} onClick={() => setStopConfirm(false)} className={button}>
                            Cancel
                        </button>
                        <button disabled={busy} onClick={() => void stop()} className={destructiveButton}>
                            {busy ? "Stopping…" : "Stop"}
                        </button>
                    </div>
                </ModalDialog>
            )}
            {!review && !stopConfirm && error && (
                <ErrorDialog title={errorTitle} message={error} onDismiss={() => setError(null)} />
            )}
            {!review && !stopConfirm && !error && failure && (
                <ErrorDialog
                    title={failure.kind === "sync" ? "Export failed" : "Commit failed"}
                    message={`${failure.filename}: ${failure.message}`}
                    onDismiss={() => {
                        void api
                            .dismissIngestError(failure.eventId)
                            .then(() => dismissError(failure.eventId))
                            .catch((reason) => setError(errorMessage(reason, "Could not dismiss the error.")));
                    }}
                />
            )}
        </>
    );
}
