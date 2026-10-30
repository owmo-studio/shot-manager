import { useEffect, useRef, useState } from "react";
import type { ImportSource } from "../../shared/desktop";
import type { ShotCollection, VideoShot } from "../../shared/shots";
import { sourcePresentation } from "./SourceListItem";

function durationLabel(seconds: number | null) {
    if (seconds === null) return "";
    const rounded = Math.floor(seconds);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function ShotCard({ shot, source }: { shot: VideoShot; source?: ImportSource }) {
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const [failedImage, setFailedImage] = useState(false);
    const card = useRef<HTMLElement>(null);
    const unavailable = !shot.available || !source?.available;
    const inactive = !unavailable && !shot.editable;
    useEffect(() => {
        if (unavailable || thumbnail || !shot.hasThumbnail || !card.current) return;
        let disposed = false;
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            window.desktop.getShotThumbnail(shot.id).then((data) => {
                if (!disposed) setThumbnail(data);
            }).catch(() => undefined);
        }, { rootMargin: "200px" });
        observer.observe(card.current);
        return () => { disposed = true; observer.disconnect(); };
    }, [shot.id, shot.hasThumbnail, unavailable, thumbnail]);

    return (
        <article ref={card} aria-disabled={unavailable || !shot.editable} data-editable={!unavailable && shot.editable}
            className={`min-w-0 rounded-lg transition ${unavailable ? "bg-red-500/8 p-2 ring-1 ring-red-500/30 hover:bg-red-500/15 hover:ring-red-400/60" : inactive ? "cursor-not-allowed opacity-50 grayscale" : ""}`}
            title={[shot.relativePath, ...(unavailable ? ["Source unavailable. Reconnect the source to edit this shot."] : inactive ? ["Source scan is queued or running. Editing is unavailable until it finishes."] : []), ...shot.warnings].join("\n")}>
            <div className={`relative flex aspect-video items-center justify-center overflow-hidden rounded-lg border ${unavailable ? "border-red-500/30 bg-red-500/5" : "border-white/8 bg-white/4"}`}>
                {thumbnail && !failedImage ? <img src={thumbnail} alt="" onError={() => setFailedImage(true)} className="size-full object-cover" /> : (
                    <div className="text-center text-zinc-600">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" className="mx-auto size-7"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m10 9 5 3-5 3V9Z" /></svg>
                        <span className="mt-2 block text-[11px]">No thumbnail</span>
                    </div>
                )}
                {unavailable && <div className="pointer-events-none absolute inset-0 bg-red-950/30">
                    <span aria-hidden="true" className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-red-400 font-bold text-[#1b2029]">!</span>
                </div>}
                {shot.durationSeconds !== null && <span className="absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 py-0.5 text-xs text-zinc-200">{durationLabel(shot.durationSeconds)}</span>}
            </div>
            <h3 className="mt-2 truncate text-[13px] text-zinc-200">{shot.filename}</h3>
            <p className="mt-0.5 truncate text-xs text-zinc-500">{source ? sourcePresentation(source).name : "Source"}</p>
            {unavailable && <p className="mt-1 text-xs font-medium text-red-300">source is unavailable</p>}
            <p className="mt-0.5 text-xs text-zinc-500">{shot.timestamp.slice(11, 19)}{shot.dateSource === "file-modified" ? " · file modified" : ""}</p>
            {!unavailable && shot.warnings.length > 0 && <p className="mt-1 text-xs text-amber-300">Metadata incomplete</p>}
        </article>
    );
}

export function ShotGrid({ collection, sources }: {
    collection: ShotCollection;
    sources: ImportSource[];
}) {
    const groups = new Map<string, VideoShot[]>();
    for (const shot of collection.shots) {
        const day = shot.timestamp.slice(0, 10);
        const group = groups.get(day) ?? [];
        group.push(shot);
        groups.set(day, group);
    }
    const busy = collection.scans.some((scan) => scan.state === "queued" || scan.state === "scanning");
    return (
        <div className="w-full self-stretch p-5 text-left">
            <header className="mb-6 flex items-center justify-between gap-4">
                <div><h2 className="text-lg font-medium">All shots</h2><p role="status" className="mt-1 text-xs text-zinc-500">{collection.shots.length} clips{busy ? " · Scanning…" : ""} · Date (oldest first)</p></div>
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
                        {shots.map((shot) => <ShotCard key={shot.id} shot={shot} source={sources.find((source) => source.id === shot.sourceId)} />)}
                    </div>
                </section>
            ))}
        </div>
    );
}
