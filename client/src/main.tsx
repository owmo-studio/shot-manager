import type { DragEvent } from "react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BackendStatus, ImportSource } from "../../shared/desktop";
import type { ShotCollection } from "../../shared/shots";
import { RemoveSourceDialog } from "./RemoveSourceDialog";
import { ShotGrid } from "./ShotGrid";
import { newlyUnavailableSources } from "./sourceAvailability";
import { SourceListItem } from "./SourceListItem";
import { SourceUnavailableDialog } from "./SourceUnavailableDialog";
import { SourceErrorDialog } from "./SourceErrorDialog";
import { ClipInspector } from "./ClipInspector";
import { MIN_INSPECTOR_WIDTH } from "./ResizableInspector";
import "./styles.css";

function App() {
    const [status, setStatus] = useState<BackendStatus>({ state: "starting", message: "Starting backend…" });
    const [sources, setSources] = useState<ImportSource[]>([]);
    const [sourcesLoaded, setSourcesLoaded] = useState(false);
    const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
    const [inspectedShotId, setInspectedShotId] = useState<string | null>(null);
    const [inspectorWidth, setInspectorWidth] = useState(MIN_INSPECTOR_WIDTH);
    const [shotCollection, setShotCollection] = useState<ShotCollection>({ revision: 0, shots: [], scans: [] });
    const latestShotRevision = useRef(-1);
    const inspectedShot = shotCollection.shots.find((shot) => shot.id === inspectedShotId);

    useEffect(() => {
        if (inspectedShotId && !inspectedShot) setInspectedShotId(null);
    }, [inspectedShotId, inspectedShot]);
    const [choosingSource, setChoosingSource] = useState(false);
    const [refreshingSourceId, setRefreshingSourceId] = useState<string | null>(null);
    const [sourceError, setSourceError] = useState<string | null>(null);
    const sourceRefreshFailed = useRef(false);
    const [removalSourceId, setRemovalSourceId] = useState<string | null>(null);
    const [removingSource, setRemovingSource] = useState(false);
    const [removalError, setRemovalError] = useState<string | null>(null);
    const removalSource = sources.find((source) => source.id === removalSourceId);
    const removalScan = shotCollection.scans.find((scan) => scan.sourceId === removalSourceId);
    const [unavailableSources, setUnavailableSources] = useState<ImportSource[]>([]);
    const notifiedUnavailable = useRef(new Set<string>());
    const [draggingFolders, setDraggingFolders] = useState(false);
    const dragDepth = useRef(0);
    const sourceRevision = useRef(0);
    const sourceMutation = useRef(false);
    const canAddSource = sourcesLoaded && !choosingSource && !refreshingSourceId && status.state === "connected";

    function receiveShots(collection: ShotCollection) {
        if (collection.revision < latestShotRevision.current) return;
        latestShotRevision.current = collection.revision;
        setShotCollection(collection);
    }

    useEffect(() => window.desktop.onShotsChanged(receiveShots), []);

    async function refreshSource(id: string) {
        if (sourceMutation.current) return;
        sourceMutation.current = true;
        sourceRevision.current += 1;
        setRefreshingSourceId(id);
        setSourceError(null);
        try {
            const result = await window.desktop.refreshSource(id);
            rememberSource(result.source);
            receiveShots(result.collection);
        } catch {
            setSourceError("Could not refresh this source. Check that it is available and not already scanning.");
        } finally {
            sourceRevision.current += 1;
            sourceMutation.current = false;
            setRefreshingSourceId(null);
        }
    }

    function rememberSource(source: ImportSource) {
        setSources((current) =>
            current.some((item) => item.path === source.path)
                ? current.map((item) => (item.path === source.path ? source : item))
                : [...current, source],
        );
    }

    useEffect(() => {
        const registeredIds = new Set(sources.map((source) => source.id));
        setShotCollection((current) => ({
            revision: current.revision,
            shots: current.shots.filter((shot) => registeredIds.has(shot.sourceId)),
            scans: current.scans.filter((scan) => registeredIds.has(scan.sourceId)),
        }));
        const additions = newlyUnavailableSources(sources, notifiedUnavailable.current);
        const unavailableIds = new Set(sources.filter((source) => !source.available).map((source) => source.id));
        setUnavailableSources((current) => [
            ...current.filter((source) => unavailableIds.has(source.id)),
            ...additions,
        ]);
    }, [sources]);

    async function addSource(droppedFiles?: File[]) {
        if (sourceMutation.current) return;
        if (!canAddSource) {
            setSourceError("Please wait for the backend to connect before adding a source.");
            return;
        }
        sourceMutation.current = true;
        sourceRevision.current += 1;
        setChoosingSource(true);
        setSourceError(null);
        try {
            if (droppedFiles) {
                let rejected = 0;
                for (const file of droppedFiles) {
                    try {
                        const source = await window.desktop.addDroppedSource(file);
                        rememberSource(source);
                    } catch {
                        rejected += 1;
                    }
                }
                if (rejected)
                    setSourceError(
                        `${rejected} dropped item${rejected === 1 ? " could" : "s could"} not be added. Drop readable folders or card roots, rather than individual files.`,
                    );
            } else {
                const source = await window.desktop.chooseSource();
                if (!source) return;
                rememberSource(source);
            }
        } catch {
            setSourceError("Could not inspect this source. Check that it is connected and readable, then try again.");
        } finally {
            setChoosingSource(false);
            sourceRevision.current += 1;
            sourceMutation.current = false;
        }
    }

    function dragEnter(event: DragEvent<HTMLElement>) {
        event.preventDefault();
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDraggingFolders(true);
    }

    function dragLeave(event: DragEvent<HTMLElement>) {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDraggingFolders(false);
    }

    function dropSources(event: DragEvent<HTMLElement>) {
        event.preventDefault();
        dragDepth.current = 0;
        setDraggingFolders(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) void addSource(files);
    }

    useEffect(() => {
        const preventNavigation = (event: globalThis.DragEvent) => event.preventDefault();
        window.addEventListener("dragover", preventNavigation);
        window.addEventListener("drop", preventNavigation);
        return () => {
            window.removeEventListener("dragover", preventNavigation);
            window.removeEventListener("drop", preventNavigation);
        };
    }, []);

    async function removeSource(id: string) {
        if (sourceMutation.current) return;
        sourceMutation.current = true;
        sourceRevision.current += 1;
        setSourceError(null);
        setRemovalError(null);
        setRemovingSource(true);
        try {
            await window.desktop.removeSource(id);
            setSources((current) => current.filter((source) => source.id !== id));
            setRemovalSourceId(null);
        } catch {
            setRemovalError("Could not remove the source. If it is scanning, wait for it to finish, then try again.");
        } finally {
            setRemovingSource(false);
            sourceRevision.current += 1;
            sourceMutation.current = false;
        }
    }

    useEffect(() => {
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        async function refresh() {
            try {
                const nextStatus = await window.desktop.getBackendStatus();
                if (!disposed) setStatus(nextStatus);
                if (nextStatus.state === "connected" && !sourceMutation.current) {
                    const revision = sourceRevision.current;
                    try {
                        const currentSources = await window.desktop.getSources();
                        const currentShots = await window.desktop.getShots();
                        if (!disposed && revision === sourceRevision.current) {
                            sourceRefreshFailed.current = false;
                            setSources(currentSources);
                            receiveShots(currentShots);
                            setSourcesLoaded(true);
                        }
                    } catch {
                        if (!disposed && !sourceRefreshFailed.current) {
                            sourceRefreshFailed.current = true;
                            setSourceError("Could not refresh sources. The app will retry shortly.");
                        }
                    }
                }
            } catch {
                if (!disposed) setStatus({ state: "unavailable", message: "Desktop connection unavailable." });
            }
            if (!disposed) timer = setTimeout(refresh, 5000);
        }
        void refresh();
        return () => {
            disposed = true;
            clearTimeout(timer);
        };
    }, []);

    return (
        <div className="flex h-screen flex-col bg-[#111318] text-sm text-zinc-200">
            <header className="flex items-center justify-between border-b border-white/8 px-6 py-4">
                <h1 className="font-semibold tracking-tight">
                    OWMO <span className="font-normal text-zinc-400">Shot Manager</span>
                </h1>
                <nav aria-label="Workspace" className="flex gap-1 rounded-lg bg-white/4 p-1">
                    <span aria-current="page" className="rounded-md bg-white/10 px-5 py-1.5">
                        Import
                    </span>
                    <button
                        disabled
                        title="Library is planned for a later milestone"
                        className="px-5 py-1.5 text-zinc-600"
                    >
                        Library
                    </button>
                </nav>
                <span className="text-xs text-zinc-500">Development</span>
            </header>
            <main className="flex min-h-0 flex-1">
                <aside className="w-72 shrink-0 overflow-y-auto border-r border-white/8 bg-white/[0.015] p-3">
                    <div className="flex items-center justify-between gap-2">
                        <h2 className="font-medium text-zinc-300">Sources</h2>
                        <button
                            onClick={() => void addSource()}
                            disabled={!canAddSource}
                            className="rounded-md border border-white/10 bg-white/4 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40"
                        >
                            +
                        </button>
                    </div>
                    {sources.length === 0 && (
                        <p className="mt-4 text-xs leading-6 text-zinc-500">
                            {sourcesLoaded ? "Add a folder or SD Card to get started." : "Loading sources…"}
                        </p>
                    )}
                    <ul aria-label="Import sources" className="mt-4 space-y-2">
                        {sources.map((source) => (
                            <SourceListItem
                                key={source.id}
                                source={source}
                                onHighlight={(highlighted) => setHoveredSourceId(highlighted ? source.id : null)}
                                scan={shotCollection.scans.find((scan) => scan.sourceId === source.id)}
                                refreshing={refreshingSourceId === source.id}
                                onRefresh={() => void refreshSource(source.id)}
                                onRemove={() => {
                                    setRemovalError(null);
                                    setRemovalSourceId(source.id);
                                }}
                            />
                        ))}
                    </ul>
                </aside>
                <section
                    aria-label="Shots from all sources"
                    onDragEnter={dragEnter}
                    onDragLeave={dragLeave}
                    onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = canAddSource ? "copy" : "none";
                    }}
                    onDrop={dropSources}
                    className={`relative flex min-w-0 flex-1 items-center justify-center overflow-y-auto text-center transition ${draggingFolders ? "bg-blue-400/5 outline-2 -outline-offset-4 outline-dashed outline-blue-400/50" : ""}`}
                >
                    {draggingFolders ? (
                        <p className="pointer-events-none text-sm text-blue-300">
                            Drop folders or a card root to add sources
                        </p>
                    ) : sources.length ? (
                        <ShotGrid collection={shotCollection} sources={sources} hoveredSourceId={hoveredSourceId} inspectedShotId={inspectedShotId} onInspect={(id) => setInspectedShotId((current) => current === id ? null : id)} />
                    ) : (
                        <div className="max-w-md p-10">
                            <button
                                onClick={() => void addSource()}
                                disabled={!canAddSource}
                                aria-label="Add Source"
                                title="Add Source"
                                className="mx-auto mb-6 grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/4 text-2xl text-zinc-400 transition hover:border-white/20 hover:bg-white/8 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40"
                            >
                                ＋
                            </button>
                            <h2 className="text-xl font-medium tracking-tight">Your workspace is ready</h2>
                            <p className="mt-3 leading-6 text-zinc-500">
                                Add a source, or drag folders here to get started.
                            </p>
                        </div>
                    )}
                </section>
                {inspectedShot && <ClipInspector key={inspectedShot.id} shot={inspectedShot} source={sources.find((source) => source.id === inspectedShot.sourceId)} width={inspectorWidth} onResize={setInspectorWidth} onClose={() => setInspectedShotId(null)} />}
            </main>
            {removalSource && (
                <RemoveSourceDialog
                    key={removalSource.id}
                    source={removalSource}
                    removing={removingSource}
                    scanning={removalScan?.state === "queued" || removalScan?.state === "scanning"}
                    error={removalError}
                    onCancel={() => setRemovalSourceId(null)}
                    onProceed={() => void removeSource(removalSource.id)}
                />
            )}
            {!removalSource && sourceError && (
                <SourceErrorDialog message={sourceError} onDismiss={() => setSourceError(null)} />
            )}
            {!removalSource && !sourceError && unavailableSources[0] && (
                <SourceUnavailableDialog
                    key={unavailableSources[0].id}
                    source={unavailableSources[0]}
                    onDismiss={() => setUnavailableSources((current) => current.slice(1))}
                />
            )}
            <footer className="flex items-center justify-between border-t border-white/8 px-5 py-3 text-xs text-zinc-500">
                <div role="status" className="flex items-center gap-2">
                    <span
                        className={`size-1.5 rounded-full ${status.state === "connected" ? "bg-emerald-400" : status.state === "starting" ? "bg-amber-400" : "bg-red-400"}`}
                    />
                    {status.state === "connected" ? "Backend connected" : status.message}
                </div>
                <span>Read-only · No ingestion operations</span>
            </footer>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
