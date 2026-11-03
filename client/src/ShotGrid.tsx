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
          ? `cursor-not-allowed grayscale opacity-50 ${selected ? "ring-zinc-300" : "ring-transparent"}`
          : skipped
            ? `${selected ? "ring-red-400/80 group-hover/shot:ring-red-300" : "ring-transparent group-hover/shot:ring-red-400/35"} bg-red-700/25 group-hover/shot:bg-red-700/35`
            : selected
              ? "bg-blue-400/5 ring-blue-400/80 group-hover/shot:bg-blue-400/15 group-hover/shot:ring-blue-300"
              : "ring-transparent group-hover/shot:bg-white/10 group-hover/shot:ring-white/25";
    useEffect(() => {
        setThumbnail(null);
        setFailedImage(false);
    }, [shot.thumbnailRevision]);

    useEffect(() => {
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
        <button id={`shot-${shot.id}`} ref={card} type="button" onClick={onSelect} disabled={unavailable || inactive} aria-label={`Inspect ${shot.filename}`} aria-pressed={selected} aria-controls="clip-inspector" data-editable={!unavailable && shot.editable} data-skipped={skipped}
            className={`-m-2 w-[calc(100%+16px)] min-w-0 rounded-lg p-2 text-left ring-1 transition duration-75 focus-visible:outline-2 focus-visible:outline-offset-2 ${skipped ? "focus-visible:outline-red-400" : "focus-visible:outline-blue-400"} disabled:cursor-not-allowed ${cardStyle}`}
            title={[sourceFilePath(source?.path, shot.relativePath), ...(unavailable ? ["Source unavailable. Reconnect the source to edit this shot."] : inactive ? ["Source rescan is queued or running. Editing is unavailable until it finishes."] : []), ...shot.warnings].join("\n")}>
            <span data-shot-thumbnail className={`relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border transition-opacity duration-150 ${skipped && !inactive ? "opacity-45" : ""} ${unavailable ? "border-red-500/30 bg-red-500/5" : "border-white/8 bg-white/4"}`}>
                {thumbnail && !failedImage ? <img src={thumbnail} alt="" onError={thumbnailFailed} className="size-full bg-black object-contain" /> : shot.thumbnailStatus === "pending" && !unavailable ? (
                    <span aria-hidden="true" className="absolute inset-0 bg-white/4 motion-safe:animate-pulse" />
                ) : null}
                {unavailable && <span className="pointer-events-none absolute inset-0 bg-red-950/30">
                    <span aria-hidden="true" className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-red-400 font-bold text-[#1b2029]">!</span>
                </span>}
            </span>
            <span className="mt-2 block truncate text-[13px] text-zinc-200">{shot.filename}</span>
            <span className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-zinc-500">
                <span className="min-w-0 truncate">{deviceLabel(shot.metadata.device) ?? "Video"}</span>
                <span className="shrink-0 text-right" title="Duration">{cardDuration(shot.durationSeconds)}</span>
            </span>
            {unavailable && <span className="mt-1 block text-xs font-medium text-red-300">source is unavailable</span>}
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
        <div className="w-full self-stretch p-5 pr-8 text-left">
            {collection.scans.filter((scan) => scan.error || scan.warnings.length).map((scan) => (
                <p key={scan.sourceId} role="status" className={`mb-4 rounded-lg border p-3 text-xs ${scan.error ? "border-red-400/25 text-red-300" : "border-amber-400/20 text-amber-300"}`}>
                    {sources.find((source) => source.id === scan.sourceId)?.name}: {scan.error ?? `${scan.warnings.length} scan issue(s). Some files or folders could not be read.`}
                </p>
            ))}
            {!collection.shots.length && <p className="mt-20 text-center text-sm text-zinc-500">{busy ? "Looking for videos…" : "No videos found in the available sources."}</p>}
            {[...groups].map(([day, shots]) => (
                <section key={day} aria-label={day} className="mb-8">
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
