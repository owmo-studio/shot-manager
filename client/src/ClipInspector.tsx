import { useEffect, useRef, useState } from "react";
import type { ImportSource } from "../../shared/desktop";
import type { ShotDetails, VideoShot } from "../../shared/shots";
import { readableMediaInfo, sourceFilePath } from "./mediaInfo";
import { ResizableInspector } from "./ResizableInspector";
import { sourcePresentation } from "./SourceListItem";

function bytesLabel(bytes: number) {
    if (!bytes) return "0 B";
    const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KB", "MB", "GB"][unit]}`;
}

export function ClipInspector({
    shot,
    source,
    width,
    onResize,
    onClose,
}: {
    shot: VideoShot;
    source?: ImportSource;
    width: number;
    onResize: (width: number) => void;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<"metadata" | "file">("metadata");
    const [variant, setVariant] = useState<"proxy" | "original">(shot.hasProxy ? "proxy" : "original");
    const [details, setDetails] = useState<ShotDetails | null>(null);
    const [detailsError, setDetailsError] = useState<string | null>(null);
    const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);
    const [sidecarCopyStatus, setSidecarCopyStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
    const video = useRef<HTMLVideoElement>(null);
    const position = useRef(0);
    const resume = useRef(false);
    const fallbackUsed = useRef(false);
    const unavailable = !shot.available || !source?.available;
    const pausedForScan = !unavailable && !shot.editable;
    const mediaAssets = details?.assets.filter((asset) => asset.role !== "xml");

    useEffect(() => {
        if (sidecarCopyStatus !== "copied" && sidecarCopyStatus !== "failed") return;
        const timeout = window.setTimeout(() => setSidecarCopyStatus("idle"), 2000);
        return () => window.clearTimeout(timeout);
    }, [sidecarCopyStatus]);

    async function copySidecar() {
        if (!details?.cameraXml) return;
        setSidecarCopyStatus("copying");
        try {
            await navigator.clipboard.writeText(details.cameraXml);
            setSidecarCopyStatus("copied");
        } catch {
            setSidecarCopyStatus("failed");
        }
    }

    useEffect(() => {
        let disposed = false;
        setDetailsError(null);
        if (unavailable) return;
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
    }, [shot.id, unavailable]);

    function switchVariant(next: "proxy" | "original", automatic = false) {
        position.current = video.current?.currentTime ?? position.current;
        resume.current = video.current ? !video.current.paused : false;
        fallbackUsed.current = true;
        setVariant(next);
        setPlaybackMessage(automatic ? "Proxy preview unavailable; trying the original." : null);
    }

    function playbackFailed() {
        if (variant === "proxy" && !fallbackUsed.current) switchVariant("original", true);
        else
            setPlaybackMessage(
                `This ${variant === "proxy" ? "proxy" : "video"} cannot be played here. Its codec may be unsupported, or the file may be unavailable.`,
            );
    }

    return (
        <ResizableInspector width={width} onResize={onResize}>
            <header className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2
                        className="truncate text-sm font-medium"
                        title={sourceFilePath(source?.path, shot.relativePath)}
                    >
                        {shot.filename}
                    </h2>
                    <p className="mt-1 truncate text-xs text-zinc-500">
                        {source ? sourcePresentation(source).name : "Source"}
                    </p>
                </div>
                <button
                    onClick={onClose}
                    aria-label="Close clip inspector"
                    className="grid size-7 shrink-0 place-items-center rounded-md text-xl text-zinc-500 hover:bg-white/8 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-blue-400"
                >
                    ×
                </button>
            </header>
            <div className="relative overflow-hidden rounded-lg border border-white/8 bg-black">
                {unavailable || pausedForScan ? (
                    <div
                        role="status"
                        className={`flex aspect-video items-center justify-center p-5 text-center text-xs ${unavailable ? "text-red-300" : "text-zinc-500"}`}
                    >
                        {unavailable
                            ? "Source is unavailable."
                            : "Preview paused while this source is queued or scanning."}
                    </div>
                ) : (
                    <video
                        ref={video}
                        key={`${shot.id}-${variant}`}
                        src={`shot-media://local/shots/${shot.id}/${variant}`}
                        controls
                        controlsList="nodownload noplaybackrate noremoteplayback"
                        disablePictureInPicture
                        disableRemotePlayback
                        playsInline
                        preload="metadata"
                        aria-label={`Preview ${shot.filename}`}
                        className="aspect-video w-full object-contain"
                        onError={playbackFailed}
                        onLoadedMetadata={() => {
                            if (!video.current) return;
                            const maximum = Number.isFinite(video.current.duration)
                                ? Math.max(0, video.current.duration - 0.05)
                                : position.current;
                            video.current.currentTime = Math.min(position.current, maximum);
                            if (resume.current) void video.current.play().catch(() => undefined);
                        }}
                    />
                )}
                {shot.hasProxy && (
                    <button
                        type="button"
                        onClick={() => switchVariant(variant === "proxy" ? "original" : "proxy")}
                        disabled={unavailable || pausedForScan}
                        aria-label="Proxy playback"
                        aria-pressed={variant === "proxy"}
                        title={
                            variant === "proxy" ? "Proxy on — switch to High Quality" : "Proxy off — switch to proxy"
                        }
                        className={`absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-40 ${variant === "proxy" ? "border-white/20 bg-black/60 text-white/80 enabled:hover:bg-black/75" : "border-white/10 bg-black/20 text-white/50 enabled:hover:bg-black/40 enabled:hover:text-white/80"}`}
                    >
                        <span
                            aria-hidden="true"
                            className={`size-1 rounded-full ${variant === "proxy" ? "bg-green-400" : "bg-white/30"}`}
                        />
                        Proxy
                    </button>
                )}
            </div>
            {playbackMessage && (
                <p role="status" className="mt-3 text-xs leading-5 text-amber-300">
                    {playbackMessage}
                </p>
            )}
            <div role="tablist" aria-label="Clip information" className="mt-5 flex rounded-lg bg-white/4 p-1">
                {(["metadata", "file"] as const).map((choice) => (
                    <button
                        key={choice}
                        id={`inspector-${choice}-tab`}
                        role="tab"
                        aria-selected={tab === choice}
                        aria-controls={`inspector-${choice}-panel`}
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
                            document.getElementById(`inspector-${next}-tab`)?.focus();
                        }}
                        className={`flex-1 rounded-md px-3 py-2 text-xs ${tab === choice ? "bg-white/10 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
                    >
                        {choice === "metadata" ? "Context" : "File info"}
                    </button>
                ))}
            </div>
            {tab === "metadata" ? (
                <section
                    role="tabpanel"
                    id="inspector-metadata-panel"
                    aria-labelledby="inspector-metadata-tab"
                    className="mt-4 rounded-lg border border-white/8 p-3"
                >
                    <p className="mb-4 text-xs leading-5 text-zinc-500">
                        Identity, project, tags, and notes will be editable here soon. These fields are placeholders.
                    </p>
                    <fieldset disabled className="space-y-4 text-xs text-zinc-500">
                        <label className="block">
                            Identity
                            <select
                                defaultValue=""
                                className="mt-1.5 block w-full rounded-md border border-white/10 bg-transparent px-3 py-2"
                            >
                                <option value="">Not assigned</option>
                                <option>OWMO</option>
                                <option>CMSH</option>
                            </select>
                        </label>
                        <label className="block">
                            Project
                            <input
                                placeholder="Optional project"
                                className="mt-1.5 block w-full rounded-md border border-white/10 bg-transparent px-3 py-2"
                            />
                        </label>
                        <label className="block">
                            Tags
                            <input
                                placeholder="Add tags…"
                                className="mt-1.5 block w-full rounded-md border border-white/10 bg-transparent px-3 py-2"
                            />
                        </label>
                        <label className="block">
                            Notes
                            <textarea
                                rows={4}
                                placeholder="Optional notes"
                                className="mt-1.5 block w-full resize-none rounded-md border border-white/10 bg-transparent px-3 py-2"
                            />
                        </label>
                    </fieldset>
                </section>
            ) : (
                <section
                    role="tabpanel"
                    id="inspector-file-panel"
                    aria-labelledby="inspector-file-tab"
                    className="mt-4 space-y-5 text-xs"
                >
                    <dl className="space-y-2 text-zinc-400">
                        {[
                            ["Filename", shot.filename],
                            [
                                "Source path",
                                details?.assets.find((asset) => asset.role === "original")?.path ??
                                    sourceFilePath(source?.path, shot.relativePath),
                            ],
                            ["Size", bytesLabel(shot.bytes)],
                            ["Camera", shot.cameraModel ?? "Unknown"],
                            [shot.dateSource === "file-modified" ? "File modified" : "Recorded", shot.timestamp],
                            [
                                "Duration",
                                shot.durationSeconds === null
                                    ? "Unknown"
                                    : `${shot.durationSeconds.toFixed(2)} seconds`,
                            ],
                        ].map(([label, value]) => (
                            <div key={label} className="grid grid-cols-[90px_1fr] gap-3">
                                <dt className="text-zinc-500">{label}</dt>
                                <dd className="min-w-0 break-all">{value}</dd>
                            </div>
                        ))}
                    </dl>
                    {detailsError && (
                        <p role="status" className="text-amber-300">
                            {detailsError}
                        </p>
                    )}
                    {!details && !detailsError && !unavailable && (
                        <p className="text-zinc-500">Loading file details…</p>
                    )}
                    {details?.errors.map((error) => (
                        <p key={error} className="text-amber-300">
                            {error}
                        </p>
                    ))}
                    <details open className="rounded-lg border border-white/8 p-3">
                        <summary className="cursor-pointer font-medium text-zinc-300">
                            Media ({mediaAssets ? mediaAssets.length : "…"})
                        </summary>
                        <div className="mt-3 space-y-4">
                            {mediaAssets?.map((asset) => (
                                <div key={asset.role}>
                                    <h3 className="mb-1 font-medium text-zinc-300">
                                        {
                                            {
                                                original: "Original",
                                                proxy: "Proxy",
                                                thumbnail: "Thumbnail",
                                                xml: "Sidecar (XML)",
                                            }[asset.role]
                                        }
                                    </h3>
                                    <p className="break-all text-zinc-500">{asset.path}</p>
                                    <p className="mt-1 text-zinc-500">{bytesLabel(asset.bytes)}</p>
                                </div>
                            ))}
                        </div>
                    </details>
                    <details className="rounded-lg border border-white/8 p-3">
                        <summary className="cursor-pointer font-medium text-zinc-300">Metadata</summary>
                        {details?.mediaInfo ? (
                            <div className="mt-3 space-y-5">
                                {readableMediaInfo(details.mediaInfo).map((group) => (
                                    <section key={group.title}>
                                        <h3 className="mb-2 font-medium text-zinc-300">{group.title}</h3>
                                        <dl className="space-y-2">
                                            {group.rows.map((row) => (
                                                <div
                                                    key={row.key}
                                                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3"
                                                >
                                                    <dt title={row.key} className="break-words text-zinc-500">
                                                        {row.label}
                                                    </dt>
                                                    <dd className="break-all text-zinc-300">{row.value}</dd>
                                                </div>
                                            ))}
                                        </dl>
                                    </section>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-3 text-zinc-500">No embedded metadata available.</p>
                        )}
                    </details>
                    {details?.cameraXml?.trim() && (
                        <details className="rounded-lg border border-white/8 p-3">
                            <summary className="cursor-pointer font-medium text-zinc-300">Sidecar (XML)</summary>
                            <div className="relative mt-3 rounded-md bg-black/20">
                                <span role="status" className="sr-only">
                                    {sidecarCopyStatus === "copied" ? "Copied" : sidecarCopyStatus === "failed" ? "Could not copy. Try again." : ""}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => void copySidecar()}
                                    disabled={sidecarCopyStatus === "copying"}
                                    aria-label="Copy sidecar to clipboard"
                                    title={sidecarCopyStatus === "copied" ? "Copied" : sidecarCopyStatus === "failed" ? "Could not copy. Try again." : "Copy to clipboard"}
                                    className={`absolute top-2 right-6 z-10 grid size-7 place-items-center rounded border border-white/10 bg-[#181b21]/90 transition duration-75 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-50 ${sidecarCopyStatus === "copied" ? "text-green-400" : sidecarCopyStatus === "failed" ? "text-amber-300" : "text-zinc-400 hover:text-zinc-200"}`}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-4">
                                        {sidecarCopyStatus === "copied" ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
                                    </svg>
                                </button>
                                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all p-3 pr-16 text-[11px] leading-5 text-zinc-500">
                                    {details.cameraXml}
                                </pre>
                            </div>
                        </details>
                    )}
                    {shot.warnings.map((warning) => (
                        <p key={warning} className="leading-5 text-amber-300">
                            {warning}
                        </p>
                    ))}
                </section>
            )}
        </ResizableInspector>
    );
}
