import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { ImportSource } from "../../shared/desktop";
import type { ShotCollection, VideoShot } from "../../shared/shots";
import { cardDuration, deviceLabel, sourceFilePath } from "./mediaInfo";
import { orderedShots } from "./shotSelection";

function ShotCard({ shot, source, selected, skipped, onSelect }: {
    shot: VideoShot; source?: ImportSource; selected: boolean; skipped: boolean;
    onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const [failedImage, setFailedImage] = useState(false);
    const card = useRef<HTMLButtonElement>(null);
    const unavailable = !shot.available || !source?.available;
    const inactive = !unavailable && !shot.editable;
    const cardStyle = unavailable
        ? `${selected ? "ring-red-400" : "ring-red-500/30"} bg-red-500/8 group-hover/shot:bg-red-500/15 group-hover/shot:ring-red-400/60`
        : inactive
          ? `cursor-not-allowed ${selected ? "ring-zinc-300" : "ring-transparent"}`
          : skipped
            ? `${selected ? "ring-red-400/80 group-hover/shot:ring-red-300" : "ring-transparent group-hover/shot:ring-red-400/35"} bg-red-700/25 group-hover/shot:bg-red-700/35`
            : selected
              ? "bg-blue-400/5 ring-blue-400/80 group-hover/shot:bg-blue-400/15 group-hover/shot:ring-blue-300"
              : "ring-transparent group-hover/shot:bg-white/10 group-hover/shot:ring-white/25";
    const ingestBusy = shot.ingestState === 'queued' || shot.ingestState === 'processing';
    const needsSyncing = shot.ingestState === 'changes-pending';
    const statusCardStyle = unavailable || skipped ? ''
        : shot.ingestState === 'processing' ? 'ingest-card-busy ingest-card-active'
        : shot.ingestState === 'queued' ? 'ingest-card-busy'
        : shot.ingestState === 'synced' ? 'ingest-card-synced'
        : needsSyncing && !inactive ? 'ingest-card-needs-sync' : '';
    const statusLabel = shot.ingestState === 'synced' ? 'Synced'
        : shot.ingestState === 'processing' ? 'Processing…'
        : shot.ingestState === 'queued' ? 'Queued'
        : shot.ingestState === 'unverified' ? 'Library not verified'
        : needsSyncing ? 'Needs Syncing' : null;
    const statusIcon = shot.ingestState === 'synced' ? '✓' : needsSyncing ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
            <path d="m16 4 4 4M4 16l-1 5 5-1L20 8a2.83 2.83 0 0 0-4-4Z" />
        </svg>
    ) : null;
    const statusLabelStyle = ingestBusy ? 'bg-black/80 text-zinc-400'
        : shot.ingestState === 'synced' ? 'bg-emerald-600 text-emerald-50 shadow-md shadow-black/40'
        : needsSyncing ? 'bg-yellow-600 text-white shadow-md shadow-black/40' : 'bg-black/80 text-amber-200';

    useEffect(() => {
        setThumbnail(null);
        setFailedImage(false);
    }, [shot.thumbnailRevision]);

    useEffect(() => {
        // Discovery queues generation; visibility only controls loading cached image data.
        if (unavailable || thumbnail || shot.thumbnailStatus === "pending" || shot.thumbnailStatus === "failed" || !card.current) return;
        let disposed = false;
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            window.desktop.getShotThumbnail(shot.id).then((data) => {
                if (!disposed && data) { setThumbnail(data); setFailedImage(false); }
            }).catch(() => undefined);
        }, { rootMargin: "200px" });
        observer.observe(card.current);
        return () => { disposed = true; observer.disconnect(); };
    }, [shot.id, shot.hasThumbnail, shot.thumbnailStatus, shot.thumbnailRevision, unavailable, thumbnail]);

    function thumbnailFailed() {
        setFailedImage(true);
    }

    return (
        <div data-shot-card className="shot-card-enter group/shot relative min-w-0">
        <button id={`shot-${shot.id}`} ref={card} type="button" onClick={onSelect} disabled={!shot.editable} aria-label={`Inspect ${shot.filename}`} aria-pressed={selected} aria-controls="clip-inspector" data-editable={shot.editable} data-skipped={skipped}
            className={`-m-2 w-[calc(100%+16px)] min-w-0 rounded-lg p-2 text-left ring-1 transition duration-75 focus-visible:outline-2 focus-visible:outline-offset-2 ${skipped ? "focus-visible:outline-red-400" : "focus-visible:outline-blue-400"} disabled:cursor-not-allowed ${cardStyle} ${statusCardStyle}`}
            title={[sourceFilePath(source?.path, shot.relativePath), ...(unavailable ? ["Source unavailable. Attributes and cached file information remain accessible."] : inactive ? ["Clip is queued for processing or being rescanned. Editing is temporarily locked."] : []), ...shot.warnings].join("\n")}>
            <span data-shot-thumbnail className={`relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border transition-opacity duration-150 ${unavailable ? "border-red-500/30 bg-red-500/5" : "border-white/8 bg-white/4"}`}>
                {statusLabel && <span data-shot-status={shot.ingestState} role={statusIcon ? 'img' : undefined} aria-label={statusIcon ? statusLabel : undefined} title={statusLabel}
                    className={`absolute top-2 z-10 rounded ${statusIcon ? 'right-2 grid size-6 place-items-center text-xs font-bold' : 'left-2 px-2 py-1 text-[10px]'} ${statusLabelStyle}`}>
                    {statusIcon ? <span aria-hidden="true">{statusIcon}</span> : statusLabel}
                </span>}
                <span data-shot-preview aria-hidden="true" className={`absolute inset-0 ${skipped && !inactive ? "opacity-45" : ""}`}>
                    {thumbnail && !failedImage ? <img data-shot-image src={thumbnail} alt="" onError={thumbnailFailed} className="size-full bg-black object-contain" /> : shot.thumbnailStatus !== "failed" && !failedImage && !unavailable ? (
                        <span aria-hidden="true" className="absolute inset-0 bg-linear-to-r from-transparent via-white/8 to-transparent bg-[length:200%_100%] motion-safe:animate-[thumbnail-shimmer_1.8s_linear_infinite]" />
                    ) : null}
                </span>
                {unavailable && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-red-950/30">
                    <span aria-hidden="true" className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-red-400 font-bold text-[#1b2029]">!</span>
                    <span className="rounded-md bg-[#111318]/80 px-3 py-1.5 text-center text-xs font-medium text-red-300">source unavailable</span>
                </span>}
            </span>
            <span data-shot-filename className="mt-2 block truncate text-[13px] text-zinc-200">{shot.filename}</span>
            <span className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-zinc-500">
                <span className="min-w-0 truncate">{deviceLabel(shot.metadata.device) ?? "Video"}</span>
                <span className="shrink-0 text-right" title="Duration">{cardDuration(shot.durationSeconds)}</span>
            </span>
            {!unavailable && shot.warnings.length > 0 && <span className="mt-1 block text-xs text-amber-300">Metadata incomplete</span>}
        </button>
        </div>
    );
}

export function ShotGrid({ collection, newestFirst, sources, selectedShotIds, skippedShotIds, onSelect }: {
    collection: ShotCollection;
    newestFirst: boolean;
    sources: ImportSource[];
    selectedShotIds: string[];
    skippedShotIds: string[];
    onSelect: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
    const groups = new Map<string, VideoShot[]>();
    const sortedShots = orderedShots(collection.shots, newestFirst);
    for (const shot of sortedShots) {
        const day = shot.timestamp.slice(0, 10);
        const group = groups.get(day) ?? [];
        group.push(shot);
        groups.set(day, group);
    }
    const busy = collection.scans.some((scan) => scan.state === "queued" || scan.state === "scanning");
    return (
        <div className="w-full shrink-0 self-start p-5 pr-8 pb-12 text-left">
            {collection.scans.filter((scan) => scan.error || scan.warnings.length).map((scan) => (
                <p key={scan.sourceId} role="status" className={`mb-4 rounded-lg border p-3 text-xs ${scan.error ? "border-red-400/25 text-red-300" : "border-amber-400/20 text-amber-300"}`}>
                    {sources.find((source) => source.id === scan.sourceId)?.name}: {scan.error ?? `${scan.warnings.length} scan issue(s). Some files or folders could not be read.`}
                </p>
            ))}
            {!collection.shots.length && <p className="mt-20 text-center text-sm text-zinc-500">{busy ? "Looking for videos…" : "No videos found in the available sources."}</p>}
            {[...groups].map(([day, shots]) => (
                <section key={day} data-shot-day aria-label={day} className="mb-8 last:mb-0">
                    <h3 className="mb-4 border-b border-white/8 pb-2 text-sm font-medium text-zinc-400">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })} <span className="ml-2 font-normal text-zinc-600">{shots.length} clips</span></h3>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-5 gap-y-6">
                        {shots.map((shot) => <ShotCard key={shot.id} shot={shot} source={sources.find((source) => source.id === shot.sourceId)}
                            selected={selectedShotIds.includes(shot.id)} skipped={skippedShotIds.includes(shot.id)}
                            onSelect={(event) => onSelect(shot.id, event)} />)}
                    </div>
                </section>
            ))}
        </div>
    );
}
