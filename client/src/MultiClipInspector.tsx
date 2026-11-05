import { ContextFields } from "./ContextFields";
import { SkipSelection } from "./SkipSelection";
import { ResizableInspector } from "./ResizableInspector";
import type { ShotCollection, VideoShot } from "../../shared/shots";
import type { ImportSource } from "../../shared/desktop";
import { sourceFilePath } from "./mediaInfo";
import { ClearOrganizationButton } from "./ClearOrganizationButton";

export function MultiClipInspector({ shots, sources, skippedCount, disabled, width, onResize, onSkipChange, onOrganizationUpdated }: {
    shots: VideoShot[]; sources: ImportSource[]; skippedCount: number; disabled: boolean; width: number; onResize: (width: number) => void;
    onSkipChange: (skipped: boolean) => void;
    onOrganizationUpdated: (collection: ShotCollection) => void;
}) {
    const count = shots.length;
    return <ResizableInspector width={width} onResize={onResize}>
        <div className="flex min-h-full flex-col">
        <header className="mb-4 flex items-start justify-between gap-3">
            <div><h2 className="text-sm font-medium">{count} Selected Clips</h2>
                <p className="mt-1 text-xs text-zinc-500">Shared tags are filled · Partial tags show a count</p></div>
            <div className="flex shrink-0 items-center gap-4">
                <SkipSelection count={count} skippedCount={skippedCount} disabled={disabled} onChange={onSkipChange} />
            </div>
        </header>
        <ul aria-label="Selected clips" className="mb-4 max-h-40 overflow-y-auto rounded-lg border border-white/8 bg-black/10 py-1 text-xs text-zinc-400 divide-y divide-white/5">
            {shots.map((shot) => <li key={shot.id} title={sourceFilePath(sources.find((source) => source.id === shot.sourceId)?.path, shot.relativePath)} className="truncate px-3 py-1.5">{shot.filename}</li>)}
        </ul>
        {disabled && <p role="status" className="mb-4 text-xs text-amber-300">Some selected clips are rescanning. Skip choices are temporarily locked.</p>}
        <div role="tablist" aria-label="Clip information" className="mt-5 flex rounded-lg bg-white/4 p-1">
            <button role="tab" aria-selected="true" aria-controls="multi-context-panel" id="multi-context-tab" className="flex-1 rounded-md bg-white/10 px-3 py-2 text-xs text-zinc-200">Attributes</button>
            <button role="tab" aria-selected="false" disabled title="Select one clip to view its file information" className="flex-1 rounded-md px-3 py-2 text-xs text-zinc-600">File info</button>
        </div>
        <section role="tabpanel" id="multi-context-panel" aria-labelledby="multi-context-tab" className="mt-4 flex flex-1 flex-col">
            <ContextFields shots={shots} onUpdated={onOrganizationUpdated} />
            <div className="mt-auto flex justify-end pt-5"><ClearOrganizationButton shots={shots} onUpdated={onOrganizationUpdated} /></div>
        </section>
        </div>
    </ResizableInspector>;
}
