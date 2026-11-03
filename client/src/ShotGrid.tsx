import { useEffect, useRef, useState } from "react";
import type { ImportSource } from "../../shared/desktop";
import type { ShotCollection, VideoShot } from "../../shared/shots";
import { deviceLabel, durationRow, sourceFilePath } from "./mediaInfo";

function ShotCard({ shot, source, selected = false, onInspect }: { shot: VideoShot; source?: ImportSource; selected?: boolean; onInspect: () => void }) {
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const [failedImage, setFailedImage] = useState(false);
    const card = useRef<HTMLButtonElement>(null);
    const unavailable = !shot.available || !source?.available;
    const inactive = !unavailable && !shot.editable;
    const cardStyle = unavailable
        ? `${selected ? "ring-red-400" : "ring-red-500/30"} bg-red-500/8 hover:bg-red-500/15 hover:ring-red-400/60`
        : inactive
          ? `cursor-not-allowed grayscale opacity-50 ${selected ? "ring-zinc-300" : "ring-transparent"}`
          : selected
            ? "bg-blue-400/5 ring-blue-400/80 hover:bg-blue-400/15 hover:ring-blue-300"
            : "ring-transparent hover:bg-white/10 hover:ring-white/25";
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
        <button ref={card} type="button" onClick={onInspect} disabled={unavailable || inactive} aria-label={`Inspect ${shot.filename}`} aria-current={selected ? true : undefined} aria-controls="clip-inspector" data-editable={!unavailable && shot.editable}
            className={`shot-card-enter -m-2 min-w-0 rounded-lg p-2 text-left ring-1 transition duration-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed ${cardStyle}`}
            title={[sourceFilePath(source?.path, shot.relativePath), ...(unavailable ? ["Source unavailable. Reconnect the source to edit this shot."] : inactive ? ["Source rescan is queued or running. Editing is unavailable until it finishes."] : []), ...shot.warnings].join("\n")}>
            <span className={`relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border ${unavailable ? "border-red-500/30 bg-red-500/5" : "border-white/8 bg-white/4"}`}>
                {thumbnail && !failedImage ? <img src={thumbnail} alt="" onError={thumbnailFailed} className="size-full object-cover" /> : shot.thumbnailStatus === "pending" && !unavailable ? (
                    <span aria-hidden="true" className="absolute inset-0 bg-white/4 motion-safe:animate-pulse" />
                ) : null}
                {unavailable && <span className="pointer-events-none absolute inset-0 bg-red-950/30">
                    <span aria-hidden="true" className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-red-400 font-bold text-[#1b2029]">!</span>
                </span>}
            </span>
            <span className="mt-2 block truncate text-[13px] text-zinc-200">{shot.filename}</span>
            <span className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-zinc-500">
                <span className="min-w-0 truncate">{deviceLabel(shot.metadata.device) ?? "Video"}</span>
                <span className="shrink-0 text-right" title="Duration">{durationRow(shot.durationSeconds, shot.metadata).value}</span>
            </span>
            {unavailable && <span className="mt-1 block text-xs font-medium text-red-300">source is unavailable</span>}
            {!unavailable && shot.warnings.length > 0 && <span className="mt-1 block text-xs text-amber-300">Metadata incomplete</span>}
        </button>
    );
}

export function ShotGrid({ collection, title, filterDescription, newestFirst, onToggleOrder, sources, inspectedShotId, onInspect }: {
    collection: ShotCollection;
    title: string;
    filterDescription: string;
    newestFirst: boolean;
    onToggleOrder: () => void;
    sources: ImportSource[];
    inspectedShotId: string | null;
    onInspect: (id: string) => void;
}) {
    const groups = new Map<string, VideoShot[]>();
    const direction = newestFirst ? -1 : 1;
    const sortedShots = [...collection.shots].sort((first, second) => direction * (
        first.timestamp.slice(0, 10).localeCompare(second.timestamp.slice(0, 10)) ||
        Date.parse(first.timestamp) - Date.parse(second.timestamp)
    ) || first.id.localeCompare(second.id));
    for (const shot of sortedShots) {
        const day = shot.timestamp.slice(0, 10);
        const group = groups.get(day) ?? [];
        group.push(shot);
        groups.set(day, group);
    }
    const busy = collection.scans.some((scan) => scan.state === "queued" || scan.state === "scanning");
    return (
        <div className="w-full self-stretch p-5 pr-8 text-left">
            <header className="mb-6 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <h2 className="break-words text-lg font-medium">{title}</h2>
                    {filterDescription && <p className="mt-1 break-words text-xs text-zinc-400">{filterDescription}</p>}
                    <div className="mt-1 flex items-center justify-between gap-2 text-sm text-zinc-500">
                        <p role="status">{collection.shots.length} clips{busy ? " · Scanning…" : ""}</p>
                        <button
                            type="button"
                            onClick={onToggleOrder}
                            aria-label="Reverse order"
                            aria-pressed={!newestFirst}
                            title={newestFirst ? "Show oldest first" : "Show newest first"}
                            className={`grid size-8 shrink-0 place-items-center rounded transition duration-75 focus-visible:outline-2 focus-visible:outline-blue-400 ${newestFirst ? "hover:bg-white/8 hover:text-zinc-200" : "bg-blue-400/15 text-blue-300 hover:bg-blue-400/25"}`}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-5">
                                <path d="M8 20V4m-4 4 4-4 4 4M16 4v16m-4-4 4 4 4-4" />
                            </svg>
                        </button>
                    </div>
                </div>
            </header>
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
                        {shots.map((shot) => <ShotCard key={shot.id} shot={shot} source={sources.find((source) => source.id === shot.sourceId)} selected={shot.id === inspectedShotId} onInspect={() => onInspect(shot.id)} />)}
                    </div>
                </section>
            ))}
        </div>
    );
}
