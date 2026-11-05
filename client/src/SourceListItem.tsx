import type { ImportSource } from "../../shared/desktop";
import type { SourceScan } from "../../shared/shots";

type SourceIconType = "camera" | "drive" | "folder";

export function sourcePresentation(source: ImportSource): { name: string; icon: SourceIconType } {
    const volumeRoot = /^\/Volumes\/[^/]+\/?$/.test(source.path);
    const cameraNames: Record<string, string> = {
        "ILME-FX30": "FX30",
        "ZV-E10M2": "ZV-E10 II",
    };

    if (source.type === "sony") {
        const camera = source.cameraModels.length
            ? `Sony ${source.cameraModels.map((model) => cameraNames[model] ?? model).join(" / ")}`
            : "Sony Camera";
        return {
            name: camera,
            icon: "camera",
        };
    }

    return { name: volumeRoot ? `${source.name} (Drive)` : source.name, icon: volumeRoot ? "drive" : "folder" };
}

function SourceIcon({ type, error }: { type: SourceIconType; error: boolean }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className={`size-6 shrink-0 ${error ? "text-red-400" : "text-slate-400"}`}
        >
            {error ? (
                <>
                    <circle cx="12" cy="12" r="10" fill="currentColor" />
                    <path d="M12 6v7" stroke="#1b2029" strokeWidth="2.5" strokeLinecap="round" />
                    <circle cx="12" cy="17" r="1.4" fill="#1b2029" />
                </>
            ) : type === "camera" ? (
                <>
                    <path d="M8 4h8l2 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2l2-3Z" fill="currentColor" />
                    <circle cx="12" cy="13" r="4" fill="#1b2029" />
                    <circle cx="19" cy="10" r="1" fill="#1b2029" />
                </>
            ) : type === "drive" ? (
                <>
                    <rect x="8" y="2" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
                    <rect x="6" y="7" width="12" height="15" rx="3" fill="currentColor" />
                    <path d="M10 4v2m4-2v2" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="12" cy="17" r="1.5" fill="#1b2029" />
                </>
            ) : (
                <path
                    d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z"
                    fill="currentColor"
                />
            )}
        </svg>
    );
}

export function SourceListItem({
    source,
    selected = false,
    onToggle,
    scan,
    refreshing = false,
    onRefresh,
    onRemove,
}: {
    source: ImportSource;
    selected?: boolean;
    onToggle: () => void;
    scan?: SourceScan;
    refreshing?: boolean;
    onRefresh: () => void;
    onRemove: () => void;
}) {
    const presentation = sourcePresentation(source);
    const unavailable = !source.available;
    const scanning = !unavailable && scan?.state === "scanning";
    const queued = !unavailable && (refreshing || !scan || scan.state === "queued");
    const inProgress = scanning || queued;
    const scanWarning = !inProgress && !!scan?.warnings.length;

    return (
        <li
            aria-busy={inProgress}
            className={`group relative rounded-lg transition duration-75 ${unavailable ? "bg-red-500/8 hover:bg-red-500/15 has-[:focus-visible]:bg-red-500/15" : scanning ? "bg-blue-500/8 hover:bg-blue-500/12 has-[:focus-visible]:bg-blue-500/12" : queued ? "bg-white/2 opacity-40 grayscale" : "hover:bg-white/4 has-[:focus-visible]:bg-white/4"}`}
        >
            <button
                type="button"
                onClick={onToggle}
                aria-pressed={selected}
                aria-label={`Filter clips from ${presentation.name}`}
                title={[presentation.name, source.path, source.warning, scan?.error, ...(scan?.warnings ?? [])].filter(Boolean).join("\n")}
                className={`flex min-h-14 w-full items-center gap-3 rounded-lg border py-2.5 pl-3 text-left transition duration-75 focus-visible:outline-2 focus-visible:outline-blue-400 ${selected ? "bg-blue-400/10 ring-1 ring-blue-400/60" : ""} ${inProgress ? "pr-3" : "pr-18"} ${unavailable ? "border-red-500/30 group-hover:border-red-400/60 group-has-[:focus-visible]:border-red-400/60" : scanning ? "border-blue-400/30 group-hover:border-blue-400/50 group-has-[:focus-visible]:border-blue-400/50" : queued ? "border-white/5" : "border-transparent"}`}
            >
                {scanning ? (
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                        className="size-6 shrink-0 text-blue-400 motion-safe:animate-spin"
                    >
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                        <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                ) : (
                    <SourceIcon type={presentation.icon} error={unavailable} />
                )}
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-zinc-200">{presentation.name}</span>
                    <span
                        className={`mt-0.5 block truncate text-xs ${unavailable ? "font-medium text-red-300" : scanning ? "font-medium text-blue-300" : "text-zinc-500"}`}
                    >
                        {unavailable
                            ? "source unavailable"
                            : scanning
                              ? scan!.clipCount > 0 ? `Scanning... ${scan!.clipCount} clips found` : "Scanning..."
                              : queued
                                ? "Queued..."
                                : `${scan!.clipCount} clips${scan!.state === "failed" || scan!.state === "interrupted" ? " · Scan interrupted" : ""}`}
                    </span>
                    {source.available && (source.warning || scanWarning) && (
                        <span className="mt-1 block text-xs text-amber-300">{source.warning ?? "Scan needs attention"}</span>
                    )}
                </span>
            </button>
            <div className={`absolute top-1/2 right-2 flex -translate-y-1/2 gap-1 opacity-0 transition duration-75 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 ${inProgress ? "invisible" : ""}`}>
            <button
                onClick={onRefresh}
                disabled={inProgress || refreshing}
                aria-label={`${unavailable ? "Re-link" : "Refresh"} ${presentation.name}`}
                title={unavailable ? "Re-link source and rescan" : inProgress ? "Wait for scanning to finish" : "Refresh source"}
                className="grid size-7 place-items-center rounded-md text-zinc-400 transition duration-75 hover:bg-white/10 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-4">
                    {unavailable ? <>
                        <path d="m10 13 4-4M8 15l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M13 9l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" />
                    </> : <>
                        <path d="M20 7v5h-5M4 17v-5h5" />
                        <path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17" />
                    </>}
                </svg>
            </button>
            <button
                onClick={onRemove}
                disabled={inProgress}
                aria-label={`Remove ${presentation.name} from sources`}
                title={inProgress ? "Wait for scanning to finish before removing this source" : "Remove source (does not delete files)"}
                className="grid size-7 place-items-center rounded-md text-zinc-400 transition duration-75 hover:bg-white/10 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" className="size-4"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
            </div>
        </li>
    );
}
