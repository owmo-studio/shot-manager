import type { ImportSource } from "../../shared/desktop";

type SourceIconType = "card" | "drive" | "folder";

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
            name: `${camera} (${volumeRoot ? "SD Card" : source.name})`,
            icon: volumeRoot ? "card" : "folder",
        };
    }

    return { name: volumeRoot ? `${source.name} (Drive)` : source.name, icon: volumeRoot ? "drive" : "folder" };
}

function SourceIcon({ type }: { type: SourceIconType }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-6 shrink-0 text-slate-400">
            {type === "card" ? (
                <>
                    <path d="M7 3h10l3 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9l3-7Z" fill="currentColor" />
                    <circle cx="12" cy="13" r="4" fill="#1b2029" />
                    <path d="M9 5h6" stroke="#1b2029" strokeWidth="1.5" strokeLinecap="round" />
                </>
            ) : type === "drive" ? (
                <>
                    <rect x="8" y="2" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
                    <rect x="6" y="7" width="12" height="15" rx="3" fill="currentColor" />
                    <path d="M10 4v2m4-2v2" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="12" cy="17" r="1.5" fill="#1b2029" />
                </>
            ) : (
                <path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z" fill="currentColor" />
            )}
        </svg>
    );
}

export function SourceListItem({ source, onRemove }: {
    source: ImportSource;
    onRemove: () => void;
}) {
    const presentation = sourcePresentation(source);

    return (
        <li className="group relative rounded-lg transition hover:bg-white/4 focus-within:bg-white/4">
            <div
                title={`${presentation.name}\n${source.path}`}
                className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-transparent py-2.5 pr-8 pl-3 text-left"
            >
                <SourceIcon type={presentation.icon} />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-zinc-200">{presentation.name}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500" aria-label={source.available ? "Clip count not available yet" : undefined}>
                        {source.available ? "— clips" : "Unavailable"}
                    </span>
                    {source.warning && <span className="mt-1 block text-xs text-amber-300">{source.warning}</span>}
                </span>
            </div>
            <button
                onClick={onRemove}
                aria-label={`Remove ${presentation.name} from sources`}
                title="Remove source (does not delete files)"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1 text-zinc-500 opacity-0 transition hover:bg-white/10 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-400 group-hover:opacity-100 group-focus-within:opacity-100"
            >
                ×
            </button>
        </li>
    );
}
