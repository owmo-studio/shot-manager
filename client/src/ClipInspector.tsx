import { errorMessage } from '../../shared/errors';
import { useEffect, useRef, useState } from "react";
import type { ImportSource } from "../../shared/desktop";
import type { ShotCollection, ShotDetails, VideoShot } from "../../shared/shots";
import { emptyVideoMetadata } from "../../shared/shots";
import { viewingProfile } from "../../shared/viewing";
import { durationRow, primaryMetadataRows, quickMediaSummary, sourceFilePath } from "./mediaInfo";
import { ResizableInspector } from "./ResizableInspector";
import { PreviewPlayer } from "./PreviewPlayer";
import type { PreviewHandle } from "./PreviewPlayer";
import { ContextFields } from "./ContextFields";
import { SkipSelection } from "./SkipSelection";
import { ClearOrganizationButton } from "./ClearOrganizationButton";

function bytesLabel(bytes: number) {
    if (!bytes) return "0 B";
    const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (
        (bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 }) +
        " " +
        ["B", "KB", "MB", "GB"][unit]
    );
}

const emptyShot: VideoShot = {
    id: "",
    sourceId: "",
    filename: "",
    relativePath: "",
    bytes: 0,
    timestamp: "",
    dateSource: "file-modified",
    dateEvidence: "",
    dateConfidence: "uncertain",
    cameraModel: null,
    metadata: emptyVideoMetadata(),
    durationSeconds: null,
    hasThumbnail: false,
    warnings: [],
    available: false,
    editable: false,
};

export function ClipInspector({
    shot: selectedShot,
    source,
    width,
    onResize,
    skipped,
    onSkipChange,
    onOrganizationUpdated,
}: {
    shot?: VideoShot;
    source?: ImportSource;
    width: number;
    onResize: (width: number) => void;
    skipped: boolean;
    onSkipChange: (skipped: boolean) => void;
    onOrganizationUpdated: (collection: ShotCollection) => void;
}) {
    const empty = !selectedShot;
    const shot = selectedShot ?? emptyShot;
    const [tab, setTab] = useState<"metadata" | "file">("metadata");
    const [details, setDetails] = useState<ShotDetails | null>(null);
    const [detailsError, setDetailsError] = useState<string | null>(null);
    const [lutEnabled, setLutEnabled] = useState(true);
    const [thumbnailBusy, setThumbnailBusy] = useState(false);
    const [thumbnailError, setThumbnailError] = useState<string | null>(null);
    const [frameReady, setFrameReady] = useState(false);
    const [thumbnailReady, setThumbnailReady] = useState(false);
    const [scrubbing, setScrubbing] = useState(false);
    const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
    const preview = useRef<PreviewHandle>(null);
    const unavailable = !shot.available || !source?.available;
    const pausedForScan = !shot.editable;
    const summary = empty ? "" : quickMediaSummary(shot.metadata);
    const rawMetadata =
        details?.embeddedMetadata
            .map((entry) => entry.label + " (" + entry.format.toUpperCase() + ")\n\n" + entry.text)
            .join("\n\n────────────────────\n\n") ?? "";

    async function setThumbnail() {
        if (empty || thumbnailBusy) return;
        setThumbnailBusy(true);
        setThumbnailError(null);
        try {
            if (!preview.current) throw new Error("Wait for a preview frame.");
            await window.desktop.setShotThumbnail(shot.id, preview.current.captureThumbnail());
        } catch (error) {
            setThumbnailError(errorMessage(error, "Thumbnail could not be updated. Check the preview and try again."));
        } finally {
            setThumbnailBusy(false);
        }
    }

    useEffect(() => { setLutEnabled(true); setFrameReady(false); setThumbnailError(null); }, [shot.id]);

    useEffect(() => {
        if (!frameReady || scrubbing) {
            setThumbnailReady(false);
            return;
        }
        const timeout = window.setTimeout(() => setThumbnailReady(true), 300);
        return () => window.clearTimeout(timeout);
    }, [frameReady, shot.id, scrubbing]);

    useEffect(() => {
        if (copyStatus !== "copied" && copyStatus !== "failed") return;
        const timeout = window.setTimeout(() => setCopyStatus("idle"), 2000);
        return () => window.clearTimeout(timeout);
    }, [copyStatus]);

    async function copyMetadata() {
        if (!rawMetadata) return;
        setCopyStatus("copying");
        try {
            await navigator.clipboard.writeText(rawMetadata);
            setCopyStatus("copied");
        } catch {
            setCopyStatus("failed");
        }
    }

    useEffect(() => {
        let disposed = false;
        setDetails(null);
        setDetailsError(null);
        if (empty || pausedForScan) return;
        window.desktop
            .getShotDetails(shot.id)
            .then((data) => {
                if (!disposed) setDetails(data);
            })
            .catch(() => {
                if (!disposed) setDetailsError("File details could not be loaded. Check that the source is connected.");
            });
        return () => {
            disposed = true;
        };
    }, [shot.id, unavailable, pausedForScan, empty]);

    return (
        <ResizableInspector width={width} onResize={onResize}>
            <div inert={empty} className={`flex min-h-full flex-col ${empty ? "opacity-40" : ""}`}>
                <header className="mb-4 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2
                            className="min-h-5 truncate text-sm font-medium"
                            title={empty ? undefined : sourceFilePath(source?.path, shot.relativePath)}
                        >
                            {shot.filename}
                        </h2>
                        <p className="mt-1 min-h-4 truncate text-xs text-zinc-500" title={summary || undefined}>
                            {summary}
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                        {viewingProfile(shot.metadata) && <button type="button" aria-label="Toggle viewing LUT" aria-pressed={lutEnabled}
                            disabled={empty || unavailable || pausedForScan}
                            title={lutEnabled ? "LUT on — view in Rec.709" : "LUT off — view original"}
                            onClick={() => setLutEnabled((enabled) => !enabled)}
                            className={"flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium transition duration-75 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40 " + (lutEnabled ? "border-white/15 bg-white/8 text-zinc-200 hover:border-white/25 hover:bg-white/15 hover:text-white" : "border-white/10 bg-black/30 text-zinc-500 hover:bg-white/8")}>
                            <span aria-hidden="true" className={"size-1.5 rounded-full " + (lutEnabled ? "bg-green-400" : "bg-zinc-600")} />LUT
                        </button>}
                        <button
                            type="button"
                            onClick={() => void setThumbnail()}
                            disabled={thumbnailBusy || unavailable || pausedForScan || scrubbing || !frameReady || !thumbnailReady}
                            aria-label="Set current frame as thumbnail"
                            title="Set current frame as thumbnail"
                            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/8 px-2 text-[10px] font-medium text-zinc-200 transition duration-75 hover:border-white/25 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40"
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                                className="size-4"
                            >
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <circle cx="8" cy="8" r="1.5" />
                                <path d="m21 15-5-5L5 21" />
                            </svg>
                            <span>{thumbnailBusy ? "Saving…" : "Set thumbnail"}</span>
                        </button>
                        <SkipSelection count={empty ? 0 : 1} skippedCount={skipped ? 1 : 0} disabled={empty || pausedForScan} onChange={onSkipChange} />
                    </div>
                </header>
                {thumbnailError && (
                    <p role="alert" className="mb-3 text-xs text-amber-300">
                        {thumbnailError}
                    </p>
                )}
                <div className={`overflow-hidden rounded-lg border ${!empty && unavailable ? "border-red-500/30 bg-red-500/8" : "border-white/8 bg-black"}`}>
                    {empty ? (
                        <div className="aspect-video" aria-label="No clip selected" />
                    ) : unavailable || pausedForScan ? (
                        <div
                            role="status"
                            className={
                                "flex aspect-video items-center justify-center p-5 text-center text-xs " +
                                (unavailable ? "text-red-300" : "text-zinc-500")
                            }
                        >
                            {unavailable
                                ? "source unavailable"
                                : "Preview paused while this source is queued for rescanning or being rescanned."}
                        </div>
                    ) : (
                        <PreviewPlayer key={shot.id} ref={preview} shot={shot} lutEnabled={lutEnabled} onReady={setFrameReady} onScrubbing={setScrubbing} />
                    )}
                </div>
                <div role="tablist" aria-label="Clip information" className="mt-5 flex rounded-lg bg-white/4 p-1">
                    {(["metadata", "file"] as const).map((choice) => (
                        <button
                            key={choice}
                            id={"inspector-" + choice + "-tab"}
                            role="tab"
                            aria-selected={tab === choice}
                            aria-controls={"inspector-" + choice + "-panel"}
                            tabIndex={tab === choice ? 0 : -1}
                            onClick={() => setTab(choice)}
                            onKeyDown={(event) => {
                                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                                event.preventDefault();
                                const next =
                                    event.key === "Home"
                                        ? "metadata"
                                        : event.key === "End"
                                          ? "file"
                                          : tab === "metadata"
                                            ? "file"
                                            : "metadata";
                                setTab(next);
                                document.getElementById("inspector-" + next + "-tab")?.focus();
                            }}
                            className={
                                "flex-1 rounded-md px-3 py-2 text-xs " +
                                (tab === choice ? "bg-white/10 text-zinc-200" : "text-zinc-500 hover:text-zinc-300")
                            }
                        >
                            {choice === "metadata" ? "Attributes" : "File info"}
                        </button>
                    ))}
                </div>
                {tab === "metadata" ? (
                    <section
                        role="tabpanel"
                        id="inspector-metadata-panel"
                        aria-labelledby="inspector-metadata-tab"
                        className="mt-4 flex flex-1 flex-col"
                    >
                        <ContextFields shots={selectedShot ? [selectedShot] : []} onUpdated={onOrganizationUpdated} />
                        <div className="mt-auto flex justify-end pt-5">
                            <ClearOrganizationButton shots={selectedShot ? [selectedShot] : []} onUpdated={onOrganizationUpdated} />
                        </div>
                    </section>
                ) : (
                    <section
                        role="tabpanel"
                        id="inspector-file-panel"
                        aria-labelledby="inspector-file-tab"
                        className="mt-4 space-y-5 text-xs"
                    >
                        <dl className="space-y-4 text-zinc-400">
                            {[
                                ...primaryMetadataRows(shot.metadata),
                                durationRow(shot.durationSeconds, shot.metadata),
                                { label: "Filename", value: shot.filename, detail: "" },
                                {
                                    label: "File path",
                                    value: details?.file.path ?? sourceFilePath(source?.path, shot.relativePath),
                                    detail: "",
                                },
                                { label: "Size", value: bytesLabel(details?.file.bytes ?? shot.bytes), detail: "" },
                                { label: "Date", value: shot.timestamp, detail: "" },
                            ].map((row) => (
                                <div key={row.label} className="grid grid-cols-[100px_minmax(0,1fr)] gap-3">
                                    <dt className="text-zinc-500">{row.label}</dt>
                                    <dd className="min-w-0 break-words">
                                        <p className="break-all text-zinc-200">{empty ? "" : row.value}</p>
                                        {!empty && row.detail && (
                                            <p className="mt-1 text-[11px] leading-5 text-zinc-500">{row.detail}</p>
                                        )}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        {shot.metadata.color.conflicts.map((message) => (
                            <p key={message} className="leading-5 text-amber-300">
                                {message}
                            </p>
                        ))}
                        {detailsError && (
                            <p role="status" className="text-amber-300">
                                {detailsError}
                            </p>
                        )}
                        {!details && !detailsError && !unavailable && !pausedForScan && (
                            <p className="text-zinc-500">Loading embedded metadata…</p>
                        )}
                        {details?.errors.map((error) => (
                            <p key={error} className="text-amber-300">
                                {error}
                            </p>
                        ))}
                        <details className="rounded-lg border border-white/8 p-3">
                            <summary className="cursor-pointer font-medium text-zinc-300">Embedded metadata</summary>
                            {rawMetadata ? (
                                <div className="relative mt-3 rounded-md bg-black/20">
                                    <span role="status" className="sr-only">
                                        {copyStatus === "copied"
                                            ? "Copied"
                                            : copyStatus === "failed"
                                              ? "Could not copy. Try again."
                                              : ""}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => void copyMetadata()}
                                        disabled={copyStatus === "copying"}
                                        aria-label="Copy embedded metadata to clipboard"
                                        title={
                                            copyStatus === "copied"
                                                ? "Copied"
                                                : copyStatus === "failed"
                                                  ? "Could not copy. Try again."
                                                  : "Copy to clipboard"
                                        }
                                        className={
                                            "absolute top-2 right-6 z-10 grid size-7 place-items-center rounded border border-white/10 bg-[#181b21]/90 transition duration-75 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-50 " +
                                            (copyStatus === "copied"
                                                ? "text-green-400"
                                                : copyStatus === "failed"
                                                  ? "text-amber-300"
                                                  : "text-zinc-400 hover:text-zinc-200")
                                        }
                                    >
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            aria-hidden="true"
                                            className="size-4"
                                        >
                                            {copyStatus === "copied" ? (
                                                <path d="m5 12 4 4L19 6" />
                                            ) : (
                                                <>
                                                    <rect x="8" y="8" width="12" height="12" rx="2" />
                                                    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                                                </>
                                            )}
                                        </svg>
                                    </button>
                                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all p-3 pr-16 text-[11px] leading-5 text-zinc-500">
                                        {rawMetadata}
                                    </pre>
                                </div>
                            ) : (
                                <p className="mt-3 text-zinc-500">
                                    {details
                                        ? "No embedded metadata could be extracted."
                                        : "Embedded metadata is not available."}
                                </p>
                            )}
                        </details>
                        {shot.warnings.map((warning) => (
                            <p key={warning} className="leading-5 text-amber-300">
                                {warning}
                            </p>
                        ))}
                    </section>
                )}
            </div>
        </ResizableInspector>
    );
}
