import { useState } from "react";
import type { IngestReview } from "../../shared/ingestion";
import { secondaryButton as button, primaryButton } from "./buttonStyles";
import { ClipReviewRow } from "./ClipReviewRow";
import { ModalDialog } from "./ModalDialog";

const bytes = (value: number) =>
    value >= 1e9
        ? `${(value / 1e9).toFixed(1)} GB`
        : value >= 1e6
          ? `${(value / 1e6).toFixed(1)} MB`
          : `${Math.max(1, Math.round(value / 1000))} KB`;

export function CommitReviewDialog({
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
    const includedIds = new Set(ids);
    const clips = review.clips.filter((clip) => includedIds.has(clip.id));
    const retiring = clips.filter(clip => clip.mode === 'synced').length;
    const transfers = clips.length - retiring;
    return (
        <ModalDialog titleId="ingest-dialog-title" title="Ready to Commit?" busy={busy} onCancel={onCancel}>
            <p className="mt-3 text-sm text-zinc-400">
                {clips.length} {clips.length === 1 ? "clip" : "clips"}
                {transfers > 0 && <> · {bytes(clips.reduce((sum, clip) => sum + clip.bytes, 0))}</>}
            </p>
            {retiring > 0 && transfers > 0 && <p className="mt-2 text-xs text-zinc-400">{transfers} to commit · {retiring} synced to remove from workspace.</p>}
            <p className="mt-2 break-all text-sm text-zinc-500">{review.libraryPath}</p>
            <div className="mt-4 max-h-[45vh] overflow-y-auto rounded-lg border border-white/10">
                {review.clips.map((clip) => {
                    const included = includedIds.has(clip.id);
                    return (
                        <ClipReviewRow key={clip.id} filename={clip.filename} mode={clip.mode} included={included} busy={busy}
                            onToggle={() => setIds(current => current.includes(clip.id)
                                ? current.filter(id => id !== clip.id) : [...current, clip.id])}>
                            <div className="mt-0.5 flex shrink-0 flex-col items-start gap-1">
                                <span className={`rounded px-2 py-0.5 text-xs ${clip.mode === 'replace' ? 'bg-yellow-400/10 text-yellow-300' : 'bg-blue-400/10 text-blue-300'}`}>
                                    {clip.mode === 'synced' ? 'Synced' : clip.mode === "replace" ? "↻ Update" : "New"}
                                </span>
                            </div>
                            <div className="min-w-0 flex-1 text-sm">
                                <p className="break-all">
                                    {clip.filename} {clip.mode !== 'synced' && <span className="text-xs text-zinc-500">{bytes(clip.bytes)}</span>}
                                </p>
                                {review.libraryEdits && clip.proxyReady && <p className="mt-1 text-xs text-zinc-400">Replace Library proxy</p>}
                                {clip.mode === 'synced' && <p className="mt-1 text-xs text-zinc-500">Remove from workspace.</p>}
                            </div>
                        </ClipReviewRow>
                    );
                })}
            </div>
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
        </ModalDialog>
    );
}

