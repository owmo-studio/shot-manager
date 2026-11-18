import { ClipViewProvider } from "./ClipViewContext";
import type { LibraryCollection } from "../../shared/library";
import { hasPendingCommit } from "./clipState";
import { AppError, errorMessage } from '../../shared/errors';
import type { DragEvent } from "react";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BackendStatus } from "../../shared/desktop";
import type { DirectoryAvailability, ShotCollection, VideoShot } from "../../shared/shots";
import { ClipInspector } from "./ClipInspector";
import { Configuration } from "./Configuration";
import { SaveStatusBanner } from "./SaveStatusBanner";
import { initializeDesktop } from "./desktop";
import { CollectionUpdates } from "./collectionUpdates";
import { MultiClipInspector } from "./MultiClipInspector";
import { orderedShots, useShotSelection } from "./shotSelection";
import { ClipFilterPanel } from './ClipFilterPanel';
import { useClipWorklist } from './clipWorklist';
import { MIN_INSPECTOR_WIDTH } from "./ResizableInspector";
import { ApplicationIndicator, applicationStatus } from "./ApplicationIndicator";
import { CommitControls } from "./CommitControls";
import { useWorkStatus } from "./useWorkStatus";
import { ShotGrid } from "./ShotGrid";
import { scrollShotIntoView } from "./scrollShotIntoView";
import { ErrorDialog } from "./ErrorDialog";
import { ClipActionDialog } from "./ClipActionDialog";
import { LibraryDeleteDialog } from "./DeleteButton";
import { DirectoryUnavailableDialog } from "./DirectoryUnavailableDialog";
import "./styles.css";

function App() {
    const [status, setStatus] = useState<BackendStatus>({ state: "starting", message: "Starting backend…" });
    const workStatus = useWorkStatus(status.state === 'connected');
    const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
    const [tab, setTab] = useState<'import' | 'library'>('import');
    const newestFirst = true;
    const [workControlTarget, setWorkControlTarget] = useState<HTMLDivElement | null>(null);
    const [inspectorWidth, setInspectorWidth] = useState(MIN_INSPECTOR_WIDTH);
    const { collection: importCollection, visible: importVisible, receive: setShotCollection, ...importQuery } =
        useClipWorklist<ShotCollection>({ revision: 0, shots: [], scans: [] });
    const { collection: libraryCollection, visible: libraryVisible, receive: setLibraryCollection, ...libraryQuery } =
        useClipWorklist<LibraryCollection>({ revision: 0, shots: [], scans: [], libraryPath: null, refreshing: false, warnings: [] });
    const activeQuery = tab === 'import' ? importQuery : libraryQuery;
    const [libraryStarting, setLibraryStarting] = useState(true);
    const latestLibraryRevision = useRef(-1);
    const shotCollection = tab === 'import' ? importCollection : libraryCollection;
    const latestShotRevision = useRef(-1);
    const visibleCollection = tab === 'import' ? importVisible : libraryVisible;
    const importSelection = useShotSelection(importCollection.shots, importVisible.shots);
    const librarySelection = useShotSelection(libraryCollection.shots, libraryVisible.shots);
    const selection = tab === 'import' ? importSelection : librarySelection;
    const selectedIds = new Set(selection.editingIds);
    const selectedShots = visibleCollection.shots.filter((shot) => selectedIds.has(shot.id));
    const inspectedShot = selectedShots.length === 1 ? selectedShots[0] : undefined;
    const displayedShots = orderedShots(visibleCollection.shots, newestFirst);
    const selectableShots = displayedShots
        .filter((shot) => shot.editable);
    const selectedLocked = selectedShots.some((shot) => !shot.editable);
    const selectedSkippedCount = selectedShots.filter(shot => shot.organization?.skipped).length;
    const navigationKey = JSON.stringify({ orderedIds: displayedShots.map((shot) => shot.id), selectableIds: selectableShots.map((shot) => shot.id) });
    const keyboardNavigation = useRef(false);
    const skipPending = useRef(new Set<string>());
    const [skipError, setSkipError] = useState<string | null>(null);

    const clearEditingSelection = useCallback(() => {
        keyboardNavigation.current = false;
        selection.dispatch({ type: "clear" });
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.closest("[data-shot-card], #clip-inspector")) focused.blur();
    }, [selection.dispatch]);

    function selectShot(id: string, modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
        keyboardNavigation.current = false;
        if (!modifiers.ctrlKey && !modifiers.metaKey && !modifiers.shiftKey && selectedShots.length === 1 && selectedShots[0].id === id) {
            clearEditingSelection();
            return;
        }
        selection.dispatch({ type: "select", id, orderedIds: displayedShots.map((shot) => shot.id),
            additive: modifiers.ctrlKey || modifiers.metaKey, range: modifiers.shiftKey });
    }

    async function changeSkip(ids: string[], skipped: boolean) {
        if (!ids.length || ids.some(id => skipPending.current.has(id) || !shotCollection.shots.some(shot => shot.id === id && shot.editable))) return;
        ids.forEach(id => skipPending.current.add(id));
        try {
            const result = await window.desktop.updateOrganization([...new Set(ids)], { field: 'skip', operation: 'set', value: skipped ? 'true' : 'false' });
            receiveShots(result.collection);
        } catch (error) { setSkipError(errorMessage(error, 'Could not save Skip.')); }
        finally { ids.forEach(id => skipPending.current.delete(id)); }
    }

    useEffect(() => {
        const blockTab = (event: KeyboardEvent) => {
            if (event.key !== "Tab") return;
            if (event.target instanceof Element && event.target.closest('[data-tag-input]')) return;
            event.preventDefault();
            event.stopPropagation();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[aria-modal="true"], dialog[open]')) return;
            if (event.target instanceof Element && event.target.closest('textarea, select, input:not([type="checkbox"]):not([type="range"]), [contenteditable="true"]')) return;
            clearEditingSelection();
        };
        window.addEventListener("keydown", blockTab, true);
        window.addEventListener("keydown", escape);
        return () => {
            window.removeEventListener("keydown", blockTab, true);
            window.removeEventListener("keydown", escape);
        };
    }, [clearEditingSelection]);

    useEffect(() => {
        const navigate = (event: KeyboardEvent) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !selection.editingIds.length) return;
            if (document.querySelector('[aria-modal="true"], dialog[open]')) return;
            if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], video, audio, .preview-player, [role="separator"], [role="slider"], [role="tab"]')) return;
            event.preventDefault();
            keyboardNavigation.current = true;
            const navigation: { orderedIds: string[]; selectableIds: string[] } = JSON.parse(navigationKey);
            const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
            const layout = vertical ? navigation.orderedIds.flatMap((id) => {
                const card = document.getElementById(`shot-${id}`);
                if (!card) return [];
                const rect = card.getBoundingClientRect();
                return [{ id, x: rect.left + rect.width / 2, y: rect.top }];
            }) : undefined;
            selection.dispatch({ type: "navigate", direction: event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1, ...navigation, layout });
        };
        window.addEventListener("keydown", navigate);
        return () => window.removeEventListener("keydown", navigate);
    }, [selection.dispatch, selection.editingIds.length, navigationKey]);

    useEffect(() => {
        if (!keyboardNavigation.current) return;
        keyboardNavigation.current = false;
        if (selection.editingIds.length !== 1) return;
        const card = document.getElementById(`shot-${selection.editingIds[0]}`);
        if (card) scrollShotIntoView(card);
        card?.focus({ preventScroll: true });
    }, [selection.editingIds]);

    const [addingClips, setAddingClips] = useState(false);
    const [workspaceError, setWorkspaceError] = useState<string | null>(null);
    const refreshFailed = useRef(false);
    const [communicationError, setCommunicationError] = useState(false);
    const [deleteTargets, setDeleteTargets] = useState<VideoShot[] | null>(null);
    const [ejectTargets, setEjectTargets] = useState<VideoShot[] | null>(null);
    const [ejectAction, setEjectAction] = useState<"eject" | "stop">("eject");
    const [ejectError, setEjectError] = useState<string | null>(null);
    const [ejectBusy, setEjectBusy] = useState(false);
    const ejectMutation = useRef(false);
    const [unavailableDirectories, setUnavailableDirectories] = useState<DirectoryAvailability[]>([]);
    const notifiedUnavailable = useRef(new Set<string>());
    const [draggingClips, setDraggingClips] = useState(false);
    const dragDepth = useRef(0);
    const workspaceMutation = useRef(false);
    const workspaceStatus = applicationStatus(status, communicationError);
    const canAcceptDroppedClips = workspaceLoaded && !addingClips && !ejectBusy && status.state === "connected"
        && !!status.application && workspaceStatus.level !== "error";
    const canAddClips = tab === "import" && canAcceptDroppedClips;

    function receiveShots(collection: ShotCollection) {
        if (collection.revision < latestShotRevision.current) return;
        latestShotRevision.current = collection.revision;
        setShotCollection(collection);
    }

    function receiveLibrary(collection: ShotCollection) {
        if (collection.revision < latestLibraryRevision.current) return;
        latestLibraryRevision.current = collection.revision;
        setLibraryCollection(collection as LibraryCollection);
    }
    const receiveView = tab === 'library' ? receiveLibrary : receiveShots;

    useEffect(() => {
        // Verify the startup catalogue before publishing its rows to the UI.
        // Subsequent tab switches use the subscribed snapshot.
        if (status.state !== 'connected' || !window.desktop.getLibrary) return;
        let disposed = false;
        let initializing = true;
        let latestNotice = -1;
        const receive = (collection: ShotCollection) => { if (!disposed) receiveLibrary(collection); };
        const updates = new CollectionUpdates(() => window.desktop.getLibrary(), receive, () => latestLibraryRevision.current);
        const unsubscribe = window.desktop.onLibraryChanged(change => {
            if (initializing) latestNotice = Math.max(latestNotice, change.revision);
            else updates.notify(change.revision);
        });
        async function refresh() {
            const cached = await window.desktop.getLibrary();
            if (disposed) return;
            try {
                receive(cached.libraryPath ? await window.desktop.refreshCatalogue() : cached);
            } catch (error) {
                receive(cached);
                throw error;
            }
        }
        const reportError = (error: unknown) => {
            if (!disposed) setWorkspaceError(errorMessage(error, 'Could not refresh the Library.'));
        };
        const configurationChanged = () => void refresh().catch(reportError);
        window.addEventListener('configuration-changed', configurationChanged);
        void refresh().catch(reportError).finally(() => {
            if (disposed) return;
            initializing = false;
            setLibraryStarting(false);
            updates.notify(latestNotice);
        });
        return () => { disposed = true; updates.dispose(); unsubscribe(); window.removeEventListener('configuration-changed', configurationChanged); };
    }, [status.state]);

    useEffect(() => {
        const updates = new CollectionUpdates(() => window.desktop.getShots(), receiveShots, () => latestShotRevision.current);
        const unsubscribe = window.desktop.onShotsChanged(change => updates.notify(change.revision));
        return () => { unsubscribe(); updates.dispose(); };
    }, []);

    useEffect(() => {
        const missing = (importCollection.directories ?? []).filter(directory => !directory.available && directory.clipIds.length);
        const currentKeys = new Set(missing.map(directory => `${directory.path}:${directory.outage}`));
        for (const key of notifiedUnavailable.current) if (!currentKeys.has(key)) notifiedUnavailable.current.delete(key);
        const additions = missing.filter(directory => !notifiedUnavailable.current.has(`${directory.path}:${directory.outage}`));
        additions.forEach(directory => notifiedUnavailable.current.add(`${directory.path}:${directory.outage}`));
        setUnavailableDirectories(current => [
            ...current.flatMap(directory => missing.find(item => item.path === directory.path && item.outage === directory.outage) ?? []),
            ...additions,
        ]);
    }, [importCollection.directories]);

    async function addClips(droppedFiles?: File[], droppedFromLibrary = false) {
        if (workspaceMutation.current) return;
        if (!(droppedFromLibrary ? canAcceptDroppedClips : canAddClips)) {
            setWorkspaceError(workspaceStatus.level === "error" ? `${workspaceStatus.message}. Resolve this issue before adding clips.` : "Please wait for the application status check before adding clips.");
            return;
        }
        workspaceMutation.current = true; setAddingClips(true); setWorkspaceError(null);
        try {
            if (droppedFiles) {
                const errors: string[] = [];
                for (const file of droppedFiles) {
                    try { await window.desktop.addDroppedClips(file); }
                    catch (error) { errors.push(errorMessage(error, "Drop supported video files, readable folders, or card roots.")); }
                }
                if (errors.length) setWorkspaceError(`${errors.length} dropped item${errors.length === 1 ? " could" : "s could"} not be added. ${[...new Set(errors)].join(" ")}`);
            } else await window.desktop.chooseClips();
            receiveShots(await window.desktop.getShots());
        } catch (error) { setWorkspaceError(errorMessage(error, "Could not add clips. Check that the file or folder is connected and readable.")); }
        finally { setAddingClips(false); workspaceMutation.current = false; }
    }

    function requestEject(ids: string[]) {
        if (ejectMutation.current) return;
        const selected = new Set(ids);
        const targets = shotCollection.shots.filter(shot => selected.has(shot.id));
        const queued = targets.filter(shot => hasPendingCommit(shot));
        if (!targets.length) return;
        setEjectError(null);
        setEjectAction(queued.length ? "stop" : "eject");
        setEjectTargets(queued.length ? queued : targets);
    }

    async function confirmClipAction() {
        if (ejectMutation.current || !ejectTargets) return;
        ejectMutation.current = true;
        setEjectError(null);
        setEjectBusy(true);
        try {
            const ids = ejectTargets.map(shot => shot.id);
            receiveShots(await (ejectAction === "stop" ? window.desktop.cancelClips(ids) : window.desktop.ejectClips(ids)));
            setEjectTargets(null);
        } catch (error) {
            // Eject authorization never authorizes stopping a newly queued Commit.
            if (ejectAction === "eject" && error instanceof AppError && error.code === "CLIP_COMMIT_ACTIVE") {
                const collection = await window.desktop.getShots().catch(() => null);
                const queued = collection?.shots.filter(shot => ejectTargets.some(target => target.id === shot.id) &&
                    (hasPendingCommit(shot)));
                if (collection && queued?.length) {
                    receiveShots(collection); setEjectAction("stop"); setEjectTargets(queued);
                } else setEjectError("Clips changed. Cancel and review the action again.");
            } else setEjectError(errorMessage(error, ejectAction === "stop" ? "Could not stop the selected commits." : "Could not eject the selected clips."));
        } finally { setEjectBusy(false); ejectMutation.current = false; }
    }

    function dragEnter(event: DragEvent<HTMLElement>) {
        event.preventDefault();
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDraggingClips(true);
    }

    function dragLeave(event: DragEvent<HTMLElement>) {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDraggingClips(false);
    }

    function dropClips(event: DragEvent<HTMLElement>) {
        event.preventDefault();
        dragDepth.current = 0;
        setDraggingClips(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) {
            const droppedOnLibrary = tab === 'library';
            if (droppedOnLibrary) setTab('import');
            void addClips(files, droppedOnLibrary);
        }
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

    useEffect(() => {
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        let running = false;
        let again = false;
        let configurationVersion = 0;
        async function refresh() {
            if (disposed) return;
            if (running) { again = true; return; }
            clearTimeout(timer); running = true;
            const version = configurationVersion;
            let nextDelay = 5000;
            try {
                const nextStatus = await window.desktop.getBackendStatus();
                if (nextStatus.state === "starting") nextDelay = 250;
                if (!disposed && version === configurationVersion) setStatus(nextStatus);
                if (nextStatus.state === "connected" && !workspaceMutation.current) {
                    try {
                        const currentShots = await window.desktop.getShots();
                        if (!disposed) {
                            refreshFailed.current = false;
                            setCommunicationError(false);
                            receiveShots(currentShots);
                            setWorkspaceLoaded(true);
                        }
                    } catch {
                        if (!disposed) setCommunicationError(true);
                        if (!disposed && !refreshFailed.current) {
                            refreshFailed.current = true;
                            setWorkspaceError("Could not refresh the workspace. The app will retry shortly.");
                        }
                    }
                }
            } catch {
                if (!disposed) setStatus({ state: "unavailable", message: "Desktop connection unavailable." });
            }
            running = false;
            if (!disposed) timer = setTimeout(refresh, again ? 0 : nextDelay);
            again = false;
        }
        const configurationChanged = () => {
            configurationVersion++;
            setStatus(current => current.state === "connected" ? { ...current, application: { level: "warning", message: "Checking Status" } } : current);
            void refresh();
        };
        window.addEventListener("configuration-changed", configurationChanged);
        void refresh();
        return () => {
            window.removeEventListener("configuration-changed", configurationChanged);
            disposed = true;
            clearTimeout(timer);
        };
    }, []);

    return (
        <ClipViewProvider mode={tab}><div className="flex h-screen flex-col bg-[#111318] text-sm text-zinc-200">
            <SaveStatusBanner />
            <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-6 border-b border-white/8 px-6 py-4">
                <h1 className="font-semibold tracking-tight">
                    OWMO <span className="font-normal text-zinc-400">Shot Manager</span>
                    <span aria-label="Application version" className="ml-2 text-xs font-normal tracking-normal text-zinc-400">{__APP_VERSION__}</span>
                </h1>
                <nav aria-label="Workspace" className="flex gap-1 rounded-lg bg-white/4 p-1">
                    {(['import', 'library'] as const).map(view => <button key={view} type="button"
                        aria-current={tab === view ? 'page' : undefined} onClick={() => setTab(view)}
                        className={`rounded-md px-5 py-1.5 ${tab === view ? 'bg-white/10' : 'text-zinc-400 hover:text-zinc-200'}`}>
                        {view === 'import' ? 'Import' : 'Library'}
                    </button>)}
                </nav>
                <Configuration workControlRef={setWorkControlTarget} />
            </header>
            <main className="flex min-h-0 flex-1">
                <aside className="w-60 shrink-0 overflow-y-auto border-r border-white/8 bg-white/1.5 p-3">
                    <ClipFilterPanel key={tab} shots={activeQuery.facetShots} filters={activeQuery.filters}
                        onChange={activeQuery.query} onReapply={() => activeQuery.query()} canReapply={activeQuery.canReapply} />
                </aside>
                <section
                    aria-label="Shot cards"
                    data-shot-scroll
                    onClick={(event) => {
                        if (!(event.target instanceof Element) || event.defaultPrevented) return;
                        if (event.target.closest("[data-shot-card], button, input, label, select, textarea, a, [role='button']")) return;
                        clearEditingSelection();
                    }}
                    onDragEnter={dragEnter}
                    onDragLeave={dragLeave}
                    onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = canAcceptDroppedClips ? "copy" : "none";
                    }}
                    onDrop={dropClips}
                    className={`relative flex min-w-0 flex-1 items-center justify-center overflow-y-auto text-center transition ${draggingClips ? "bg-blue-400/5 outline-2 -outline-offset-4 outline-dashed outline-blue-400/50" : ""}`}
                >
                    {tab === 'library' && libraryStarting && status.state !== 'unavailable' ? (
                        <h2 role="status" className="text-xl font-medium tracking-tight">Refreshing Library…</h2>
                    ) : tab === 'library' ? (
                        <div className={`w-full ${libraryCollection.shots.length ? 'self-start' : 'self-stretch flex flex-col'}`} aria-busy={libraryCollection.refreshing}>
                            {libraryCollection.refreshing && <p role="status" className="sr-only">Refreshing Library…</p>}
                            {libraryCollection.libraryPath && libraryCollection.error && <p role="status" className="px-5 pt-4 text-left text-xs text-red-300">{libraryCollection.error}</p>}
                            {libraryCollection.warnings.length > 0 && <p role="status" title={libraryCollection.warnings.join('\n')} className="px-5 pt-4 text-left text-xs text-amber-300">{libraryCollection.warnings.length} metadata files could not be refreshed.</p>}
                            {libraryCollection.shots.length ? <ShotGrid key="library-grid" collection={visibleCollection} newestFirst={newestFirst}
                                selectedShotIds={selection.editingIds} onSelect={selectShot} /> : <div className="flex flex-1 items-center justify-center">
                                <div className="max-w-md p-10">
                                    <h2 className="text-xl font-medium tracking-tight">{!libraryCollection.libraryPath ? 'Library Not Configured' : libraryCollection.refreshing ? 'Refreshing Library…' : libraryCollection.error ? 'Library Unavailable' : 'Library Empty'}</h2>
                                </div>
                            </div>}
                        </div>
                    ) : draggingClips ? (
                        <p className="pointer-events-none text-sm text-blue-300">
                            {canAcceptDroppedClips ? "Drop videos, folders, or a card root to add clips" : "Adding clips is unavailable"}
                        </p>
                    ) : shotCollection.shots.length || shotCollection.scans.some(scan => scan.state === 'queued' || scan.state === 'scanning' || scan.error || scan.warnings.length) ? (
                        <ShotGrid
                            key="import-grid" collection={visibleCollection}
                            newestFirst={newestFirst}
                            selectedShotIds={selection.editingIds}
                            onSelect={selectShot}
                        />
                    ) : (
                        <div className="max-w-md p-10">
                            <button
                                onClick={() => void addClips()}
                                disabled={!canAddClips}
                                aria-label="Add clips"
                                title="Add clips"
                                className="mx-auto mb-6 grid size-14 place-items-center rounded-2xl border border-blue-500 bg-blue-500 text-2xl text-white transition enabled:hover:border-blue-400 enabled:hover:bg-blue-400 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40"
                            >
                                ＋
                            </button>
                            <h2 className="text-xl font-medium tracking-tight">{workspaceStatus.level === "ready" ? "Add clips to begin" : workspaceStatus.message}</h2>
                        </div>
                    )}
                </section>
                    {selectedShots.length > 1 ? <MultiClipInspector key={tab}
                        onOrganizationUpdated={receiveView}
                        onDelete={() => setDeleteTargets([...selectedShots])}
                        onEject={() => requestEject(selectedShots.map(shot => shot.id))} ejectBusy={ejectBusy}
                        shots={orderedShots(selectedShots, newestFirst)} skippedCount={selectedSkippedCount} disabled={selectedLocked}
                        width={inspectorWidth} onResize={setInspectorWidth}
                        onSkipChange={(skipped) => changeSkip(selectedShots.map((shot) => shot.id), skipped)}
                    /> : <ClipInspector
                        onOrganizationUpdated={receiveView}
                        onDelete={() => setDeleteTargets([...selectedShots])}
                        onEject={() => requestEject(selectedShots.map(shot => shot.id))} ejectBusy={ejectBusy}
                        key={`${tab}:${inspectedShot?.id ?? "empty"}`}
                        shot={inspectedShot}
                        width={inspectorWidth}
                        onResize={setInspectorWidth}
                        onSkipChange={(skipped) => changeSkip(selectedShots.map((shot) => shot.id), skipped)}
                    />}
            </main>
            {deleteTargets && <LibraryDeleteDialog shots={deleteTargets} onClose={() => setDeleteTargets(null)} />}
            {ejectTargets && <ClipActionDialog key={ejectAction} action={ejectAction} shots={ejectTargets} busy={ejectBusy} error={ejectError}
                onCancel={() => { if (!ejectBusy) setEjectTargets(null); }}
                onConfirm={() => void confirmClipAction()} />}
            {!ejectTargets && skipError && <ErrorDialog title="Skip could not be saved" message={skipError} onDismiss={() => setSkipError(null)} />}
            {!ejectTargets && !skipError && workspaceError && <ErrorDialog title="Workspace error" message={workspaceError} onDismiss={() => setWorkspaceError(null)} />}
            {!ejectTargets && !skipError && !workspaceError && tab === 'import' && unavailableDirectories.length > 0 && <DirectoryUnavailableDialog
                directories={unavailableDirectories} onDismiss={() => setUnavailableDirectories([])}
                onEject={ids => { setUnavailableDirectories([]); requestEject(ids); }} />}
            <footer className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-5 border-t border-white/8 px-5 py-2.5 text-xs text-zinc-500">
                <ApplicationIndicator backend={status} communicationError={communicationError} />
                <CommitControls key={tab} workControlTarget={workControlTarget} status={workStatus.status} receiveStatus={workStatus.receiveStatus} dismissError={workStatus.dismissError} selectedShotIds={selectedShots.map(shot => shot.id)} shots={visibleCollection.shots} catalogueRefreshing={tab === 'library' && (libraryStarting || libraryCollection.refreshing)} connected={status.state === 'connected'} onRefresh={async () => receiveView(await (tab === 'library' ? window.desktop.getLibrary() : window.desktop.getShots()))} />
            </footer>
        </div></ClipViewProvider>
    );
}

initializeDesktop();
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
