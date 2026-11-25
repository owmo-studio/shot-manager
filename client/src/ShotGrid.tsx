import { useClipView } from "./ClipViewContext";
import type { MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { ShotCollection, VideoShot } from "../../shared/shots";
import { cardDuration, deviceLabel } from "./mediaInfo";
import { orderedShots } from "./shotSelection";

const readinessLabels = {
    unchecked: 'Unchecked', preparing: 'Preparing', ready: 'Ready to Commit', committed: 'Committed', unavailable: 'Unavailable',
};
const readinessColors = {
    unchecked: 'border border-white/25', preparing: 'border border-white/65', ready: 'bg-yellow-400', committed: 'bg-blue-500', unavailable: 'bg-red-500',
};
const qualityIndicators = {
    preferred: { symbol: '★', label: 'Preferred', color: 'text-yellow-300' },
    usable: { symbol: '✓', label: 'Usable', color: 'text-blue-300' },
    low: { symbol: '▼', label: 'Low', color: 'text-red-400' },
};

function ShotCard({
    shot,
    selected,
    onSelect,
}: {
    shot: VideoShot;
    selected: boolean;
    onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
    const { api, mode } = useClipView();
    const [thumbnail, setThumbnail] = useState<{ url: string; revision?: number } | null>(null);
    const [failedImage, setFailedImage] = useState(false);
    const card = useRef<HTMLButtonElement>(null);
    const skipped = !!shot.organization?.skipped;
    const quality = shot.organization?.rating ? qualityIndicators[shot.organization.rating] : null;
    const unavailable = !shot.available;
    const inactive = !unavailable && !shot.editable;
    const cardStyle = unavailable
        ? `${selected ? "ring-red-400" : "ring-red-500/30"} bg-red-500/8 group-hover/shot:bg-red-500/15 group-hover/shot:ring-red-400/60`
        : inactive
          ? `cursor-default ${selected ? "ring-zinc-300" : "ring-transparent"}`
          : skipped
            ? `${selected ? "ring-zinc-300 group-hover/shot:ring-zinc-200" : "ring-transparent group-hover/shot:ring-zinc-400/35"} bg-black/40 group-hover/shot:bg-black/50`
            : selected
              ? "bg-blue-400/5 ring-blue-400/80 group-hover/shot:bg-blue-400/15 group-hover/shot:ring-blue-300"
              : "ring-transparent group-hover/shot:bg-white/10 group-hover/shot:ring-white/25";
    const discovering = !shot.hasThumbnail && !shot.editable && !shot.ingestState && shot.thumbnailStatus !== "failed";
    const statusCardStyle =
        unavailable || skipped
            ? ""
            : shot.ingestState === "processing"
              ? "ingest-card-busy ingest-card-active"
              : shot.ingestState === "queued"
                ? "ingest-card-busy ingest-card-queued"
                : shot.ingestState === "synced"
                  ? "ingest-card-synced"
                  : shot.ingestState === "changes-pending" && !inactive
                    ? "ingest-card-needs-sync"
                    : "";
    const proxyLocal = shot.proxyState === "ready" && shot.proxyLocation === "cache";
    const proxyLibrary = shot.proxyState === "ready" && shot.proxyLocation === "library";
    const proxyEncoding = shot.proxyState === "encoding";
    const readiness = shot.mediaReadiness ?? { state: 'unchecked' as const };
    const readinessLabel = `Media readiness: ${readinessLabels[readiness.state]}${readiness.detail ? ` — ${readiness.detail}` : ''}`;
    const metadataSaving = shot.ingestState === "processing" && shot.workKind === 'metadata';
    const transferring = shot.ingestState === "processing" && !metadataSaving;
    const working = transferring || metadataSaving;
    const indicatorBusy = working || proxyEncoding;
    const indicatorStyle = indicatorBusy
        ? `border-2 motion-safe:animate-spin ${working ? shot.workKind === 'sync' ? 'border-emerald-300/25 border-t-emerald-300' : 'border-blue-400/25 border-t-blue-400' : 'border-yellow-300/25 border-t-yellow-300'}`
        : `${readinessColors[readiness.state]} ${readiness.state === 'ready' || readiness.state === 'committed' || readiness.state === 'unavailable' ? 'shadow-[0_2px_4px_rgb(0_0_0/80%)]' : ''}`;
    const progressLabel = metadataSaving ? "Saving metadata to Library" : transferring ? shot.workKind === 'sync' ? "Exporting to destination" : "Committing to Library" : proxyEncoding ? "Generating proxy" : null;
    const progressPercent = Math.max(0, Math.min(100, (transferring ? shot.transferPercent : shot.proxyPercent) ?? 0));
    const proxyLabel = proxyLibrary
        ? "Proxy in Library"
        : proxyLocal
          ? "Proxy ready in Cache"
          : proxyEncoding
            ? `Generating proxy: ${shot.proxyPercent ?? 0}%`
            : (shot.proxyError ??
              (shot.proxyState === "unverified" ? "Proxy not verified in Library" : "Proxy missing or queued"));
    const activity =
        metadataSaving
            ? "Saving metadata"
            : shot.ingestState === "processing"
              ? `${shot.workKind === 'sync' ? 'Exporting' : 'Committing'}: ${shot.transferPercent ?? 0}%`
              : shot.ingestState === "queued"
                ? shot.workKind === 'metadata'
                    ? "Queued to save metadata"
                    : proxyLocal || proxyLibrary
                      ? "Queued for transfer"
                      : "Queued: waiting for proxy"
                : shot.ingestState === "synced"
                  ? "Synced"
                  : shot.ingestState === "changes-pending"
                    ? shot.pendingProxy ? "Update · Replacement proxy ready to commit" : "Needs Syncing"
                    : discovering
                      ? "Discovering: preparing thumbnail"
                      : "Editable";

    useEffect(() => {
        // Keep the displayed image while a refreshed revision loads. Clearing it first
        // makes the cached Library view flash a second time on tab entry.
        if (
            (unavailable && mode === "import") ||
            (thumbnail && thumbnail.revision === shot.thumbnailRevision) ||
            shot.thumbnailStatus === "pending" ||
            shot.thumbnailStatus === "failed" ||
            !card.current
        )
            return;
        let disposed = false;
        const observer = new IntersectionObserver(
            (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                observer.disconnect();
                api
                    .getShotThumbnail(shot.id)
                    .then((data) => {
                        if (!disposed && data) {
                            setThumbnail({ url: data, revision: shot.thumbnailRevision });
                            setFailedImage(false);
                        }
                    })
                    .catch(() => undefined);
            },
            { rootMargin: "200px" },
        );
        observer.observe(card.current);
        return () => {
            disposed = true;
            observer.disconnect();
        };
    }, [shot.id, shot.hasThumbnail, shot.thumbnailStatus, shot.thumbnailRevision, unavailable, thumbnail]);

    function thumbnailFailed() {
        setFailedImage(true);
    }

    return (
        <div data-shot-card className="shot-card-enter group/shot relative min-w-0">
            <button
                id={`shot-${shot.id}`}
                ref={card}
                type="button"
                onClick={onSelect}
                aria-label={`Inspect ${shot.filename}`}
                aria-description={`${skipped ? "Skipped. " : ""}${activity}. ${readinessLabel}`}
                aria-pressed={selected}
                aria-controls="clip-inspector"
                data-editable={shot.editable}
                data-skipped={skipped}
                data-shot-status={shot.ingestState ?? (discovering ? "discover" : "editable")}
                className={`-m-2 w-[calc(100%+16px)] min-w-0 rounded-lg p-2 text-left ring-1 transition duration-75 focus-visible:outline-2 focus-visible:outline-offset-2 ${skipped ? "focus-visible:outline-zinc-300" : "focus-visible:outline-blue-400"} disabled:cursor-not-allowed ${cardStyle} ${statusCardStyle}`}
                title={[
                    shot.filePath ?? shot.relativePath,
                    activity,
                    ...(unavailable
                        ? ["Source unavailable. Attributes and cached file information remain accessible."]
                        : inactive
                          ? ["Clip is queued for a Library commit or being rescanned. Editing is temporarily locked."]
                          : []),
                    ...shot.warnings,
                ].join("\n")}
            >
                <span
                    data-shot-thumbnail
                    className={`relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg ring-1 ring-inset transition-opacity duration-150 ${unavailable ? "ring-red-500/30 bg-red-500/5" : skipped ? "ring-white/5 bg-black" : "ring-white/8 bg-white/4"}`}
                >
                    {!skipped && <span
                        data-media-readiness={readiness.state}
                        data-proxy-state={shot.proxyState}
                        data-proxy-location={shot.proxyLocation}
                        data-readiness-working={indicatorBusy ? 'true' : undefined}
                        role="img"
                        aria-label={indicatorBusy ? `${progressLabel}. ${readinessLabel}` : readinessLabel}
                        title={indicatorBusy ? `${progressLabel}. ${readinessLabel}` : readinessLabel}
                        className={`absolute left-1.5 top-1.5 z-10 size-3 rounded-full ${indicatorStyle}`}
                    />}
                    {(working || proxyEncoding) && (
                        <span data-shot-activity={working ? 'transfer' : 'proxy'} role="status" className="sr-only">
                            {working ? activity : proxyLabel}
                        </span>
                    )}
                    <span
                        data-shot-preview
                        data-shot-working={!skipped && (working || proxyEncoding) ? "true" : undefined}
                        aria-hidden="true"
                        className={`absolute inset-0 ${skipped ? "opacity-15" : ""}`}
                    >
                        {thumbnail && !failedImage ? (
                            <img
                                data-shot-image
                                src={thumbnail.url}
                                alt=""
                                onError={thumbnailFailed}
                                className="size-full bg-black object-contain"
                            />
                        ) : shot.thumbnailStatus !== "failed" && !failedImage && !unavailable ? (
                            <span
                                aria-hidden="true"
                                className="absolute inset-0 bg-linear-to-r from-transparent via-white/8 to-transparent bg-[length:200%_100%] motion-safe:animate-[thumbnail-shimmer_1.8s_linear_infinite]"
                            />
                        ) : null}
                    </span>
                    {unavailable && (
                        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-red-950/30">
                            <span className="rounded-md bg-[#111318]/80 px-3 py-1.5 text-center text-xs font-medium text-red-300">
                                source unavailable
                            </span>
                        </span>
                    )}
                    {(['group', 'camera'] as const).map(field => {
                            const value = shot.organization?.[field];
                            const label = field === 'group' ? 'Group' : 'Camera';
                            return value ? <span key={field} data-shot-tag={field}
                                title={`${label}: ${value}`} aria-label={`${label}: ${value}`}
                                className={`absolute bottom-2 z-10 max-w-[45%] truncate rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-white ${field === 'group' ? 'left-1.5' : 'right-1.5'}`}>
                                {value}
                            </span> : null;
                    })}
                    {(transferring || proxyEncoding) && (
                        <progress
                            data-shot-progress
                            data-work-type={transferring ? shot.workKind === 'sync' ? "export" : "commit" : "proxy"}
                            aria-label={progressLabel ?? "Transfer progress"}
                            title={progressLabel ?? "Transfer progress"}
                            max={100}
                            value={progressPercent}
                            className="shot-work-progress absolute bottom-0 left-0 z-20 block h-[6px] w-full"
                        />
                    )}
                </span>
                <span className="mt-2 flex items-center justify-between gap-2">
                    <span
                        data-shot-filename
                        className={`min-w-0 truncate text-[13px] ${skipped && !unavailable ? "text-zinc-500" : "text-zinc-200"}`}
                    >
                        {shot.filename}
                    </span>
                    {quality && <span data-shot-quality={shot.organization?.rating}
                        role="img" aria-label={`Quality: ${quality.label}`} title={`Quality: ${quality.label}`}
                        className={`shrink-0 text-sm font-bold leading-none ${quality.color}`}>
                        <span aria-hidden="true">{quality.symbol}</span>
                    </span>}
                </span>
                <span className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-zinc-500">
                    <span className="min-w-0 truncate">{deviceLabel(shot.metadata.device) ?? "Video"}</span>
                    <span className="shrink-0 text-right" title="Duration">
                        {cardDuration(shot.durationSeconds)}
                    </span>
                </span>
                {!unavailable && shot.warnings.length > 0 && (
                    <span className="mt-1 block text-xs text-amber-300">Metadata incomplete</span>
                )}
            </button>
        </div>
    );
}

export function ShotGrid({
    collection,
    newestFirst,
    selectedShotIds,
    onSelect,
}: {
    collection: ShotCollection;
    newestFirst: boolean;
    selectedShotIds: string[];
    onSelect: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
    const groups = new Map<string, VideoShot[]>();
    const selectedIds = new Set(selectedShotIds);
    const sortedShots = orderedShots(collection.shots, newestFirst);
    for (const shot of sortedShots) {
        const day = shot.timestamp.slice(0, 10);
        const group = groups.get(day) ?? [];
        group.push(shot);
        groups.set(day, group);
    }
    const activeScans = collection.scans.filter(scan => scan.state === "queued" || scan.state === "scanning");
    const busy = activeScans.length > 0;
    return (
        <div className="w-full shrink-0 self-start p-5 pr-8 pb-12 text-left">
            {busy && <div role="status" aria-label="Discovery progress" title={activeScans.map(scan => scan.path).filter(Boolean).join("\n")}
                className="mb-4 rounded-lg bg-white/4 px-3 py-2 text-left text-xs text-zinc-400">
                {activeScans.length > 1 ? `Scanning ${activeScans.length} folders…` : "Scanning…"} · {activeScans.reduce((total, scan) => total + scan.clipCount, 0)} clips found
            </div>}
            {collection.scans
                .filter((scan) => scan.error || scan.warnings.length)
                .map((scan) => (
                    <p
                        key={scan.discoveryId}
                        role="status"
                        className={`mb-4 rounded-lg border p-3 text-xs ${scan.error ? "border-red-400/25 text-red-300" : "border-amber-400/20 text-amber-300"}`}
                    >
                        {scan.path ? `${scan.path}: ` : ""}
                        {scan.error ??
                            `${scan.warnings.length} scan issue(s). Some files or folders could not be read.`}
                    </p>
                ))}
            {!collection.shots.length && (
                <p className="mt-20 text-center text-sm text-zinc-500">
                    {busy ? "Looking for videos…" : "No matching clips."}
                </p>
            )}
            {[...groups].map(([day, shots]) => (
                <section key={day} data-shot-day aria-label={day} className="mb-8 last:mb-0">
                    <h3 className="mb-4 border-b border-white/8 pb-2 text-sm font-medium text-zinc-400">
                        {new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                        })}{" "}
                        <span className="ml-2 font-normal text-zinc-600">{shots.length} clips</span>
                    </h3>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-5 gap-y-6">
                        {shots.map((shot) => (
                            <ShotCard
                                key={shot.id}
                                shot={shot}
                                selected={selectedIds.has(shot.id)}
                                onSelect={(event) => onSelect(shot.id, event)}
                            />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
