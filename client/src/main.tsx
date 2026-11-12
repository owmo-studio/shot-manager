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
import { clipIdentity, uniqueShots, orderedShots, useShotSelection } from "./shotSelection";
import { deviceLabel } from "./mediaInfo";
import { MIN_INSPECTOR_WIDTH } from "./ResizableInspector";
import { ApplicationIndicator, applicationStatus } from "./ApplicationIndicator";
import { IngestFooter } from "./IngestFooter";
import { ShotGrid } from "./ShotGrid";
import { scrollShotIntoView } from "./scrollShotIntoView";
import { SourceErrorDialog } from "./SourceErrorDialog";
import { ClipActionDialog } from "./ClipActionDialog";
import { DirectoryUnavailableDialog } from "./DirectoryUnavailableDialog";
import "./styles.css";

function App() {
    const [status, setStatus] = useState<BackendStatus>({ state: "starting", message: "Starting backend…" });
    const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
    const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
    const newestFirst = true;
    const [libraryActions, setLibraryActions] = useState<HTMLDivElement | null>(null);
    const [inspectorWidth, setInspectorWidth] = useState(MIN_INSPECTOR_WIDTH);
    const [shotCollection, setShotCollection] = useState<ShotCollection>({ revision: 0, shots: [], scans: [] });
    const latestShotRevision = useRef(-1);
    const allUniqueShots = uniqueShots(shotCollection.shots);
    const workspaceCollection = { ...shotCollection, shots: allUniqueShots };
    const deviceCounts = new Map<string, number>();
    for (const shot of workspaceCollection.shots) {
        const device = deviceLabel(shot.metadata.device) ?? "Video";
        deviceCounts.set(device, (deviceCounts.get(device) ?? 0) + 1);
    }
    const devices = [...deviceCounts].sort(([first], [second]) => first.localeCompare(second));
    const deviceKeys = JSON.stringify(devices.map(([name]) => name));
    const activeDevices = selectedDevices.filter((name) => deviceCounts.has(name));
    const visibleCollection = activeDevices.length ? {
        ...workspaceCollection,
        shots: workspaceCollection.shots.filter((shot) => activeDevices.includes(deviceLabel(shot.metadata.device) ?? "Video")),
    } : workspaceCollection;
    const selection = useShotSelection(shotCollection.shots, visibleCollection.shots);
    const selectedShots = visibleCollection.shots.filter((shot) => selection.editingIds.includes(shot.id));
    const inspectedShot = selectedShots.length === 1 ? selectedShots[0] : undefined;
    const displayedShots = orderedShots(visibleCollection.shots, newestFirst);
    const selectableShots = displayedShots
        .filter((shot) => shot.editable);
    const selectedLocked = selectedShots.some((shot) => !shot.editable);
    const skippedKeys = new Set(shotCollection.shots.filter(shot => selection.skippedIds.includes(shot.id)).map(clipIdentity));
    const skippedShotIds = shotCollection.shots.filter(shot => skippedKeys.has(clipIdentity(shot))).map(shot => shot.id);
    const selectedSkippedCount = selectedShots.filter(shot => skippedKeys.has(clipIdentity(shot))).length;
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

    useEffect(() => {
        const available = new Set<string>(JSON.parse(deviceKeys));
        setSelectedDevices((current) => current.some((name) => !available.has(name))
            ? current.filter((name) => available.has(name)) : current);
    }, [deviceKeys]);

    const [addingClips, setAddingClips] = useState(false);
    const [workspaceError, setWorkspaceError] = useState<string | null>(null);
    const refreshFailed = useRef(false);
    const [communicationError, setCommunicationError] = useState(false);
    const [ejectTargets, setEjectTargets] = useState<VideoShot[] | null>(null);
    const [ejectAction, setEjectAction] = useState<"eject" | "stop">("eject");
    const [ejectError, setEjectError] = useState<string | null>(null);
    const [ejectBusy, setEjectBusy] = useState(false);
    const ejectMutation = useRef(false);
    const [unavailableDirectories, setUnavailableDirectories] = useState<DirectoryAvailability[]>([]);
    const notifiedUnavailable = useRef(new Set<string>());
    const [draggingFolders, setDraggingFolders] = useState(false);
    const dragDepth = useRef(0);
    const workspaceMutation = useRef(false);
    const workspaceStatus = applicationStatus(status, communicationError);
    const canAddClips = workspaceLoaded && !addingClips && !ejectBusy && status.state === "connected"
        && !!status.application && workspaceStatus.level !== "error";

    function receiveShots(collection: ShotCollection) {
        if (collection.revision < latestShotRevision.current) return;
        latestShotRevision.current = collection.revision;
        setShotCollection(collection);
    }

    useEffect(() => {
        const updates = new CollectionUpdates(() => window.desktop.getShots(), receiveShots, () => latestShotRevision.current);
        const unsubscribe = window.desktop.onShotsChanged(change => updates.notify(change.revision));
        return () => { unsubscribe(); updates.dispose(); };
    }, []);

    useEffect(() => {
        const missing = (shotCollection.directories ?? []).filter(directory => !directory.available && directory.clipIds.length);
        const currentKeys = new Set(missing.map(directory => `${directory.path}:${directory.outage}`));
        for (const key of notifiedUnavailable.current) if (!currentKeys.has(key)) notifiedUnavailable.current.delete(key);
        const additions = missing.filter(directory => !notifiedUnavailable.current.has(`${directory.path}:${directory.outage}`));
        additions.forEach(directory => notifiedUnavailable.current.add(`${directory.path}:${directory.outage}`));
        setUnavailableDirectories(current => [
            ...current.flatMap(directory => missing.find(item => item.path === directory.path && item.outage === directory.outage) ?? []),
            ...additions,
        ]);
    }, [shotCollection.directories]);

    async function addClips(droppedFiles?: File[]) {
        if (workspaceMutation.current) return;
        if (!canAddClips) {
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
        const targets = allUniqueShots.filter(shot => ids.includes(shot.id));
        const queued = targets.filter(shot => shot.ingestState === "queued" || shot.ingestState === "processing");
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
                    (shot.ingestState === "queued" || shot.ingestState === "processing"));
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
        if (files.length) void addClips(files);
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
        <div className="flex h-screen flex-col bg-[#111318] text-sm text-zinc-200">
            <SaveStatusBanner />
            <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-6 border-b border-white/8 px-6 py-4">
                <h1 className="font-semibold tracking-tight">
                    OWMO <span className="font-normal text-zinc-400">Shot Manager</span>
                </h1>
                <nav aria-label="Workspace" className="flex gap-1 rounded-lg bg-white/4 p-1">
                    <span aria-current="page" className="rounded-md bg-white/10 px-5 py-1.5">
                        Import
                    </span>
                    <button
                        disabled
                        title="Library — coming next"
                        className="px-5 py-1.5 text-zinc-600"
                    >
                        Library
                    </button>
                </nav>
                <Configuration libraryActionsRef={setLibraryActions} />
            </header>
            <main className="flex min-h-0 flex-1">
                <aside className="w-60 shrink-0 overflow-y-auto border-r border-white/8 bg-white/1.5 p-3">
                    <section aria-label="Filters">
                        <ul aria-label="Device filters" className="space-y-1">
                            <li>
                                <button type="button" aria-label="Show all clips"
                                    onClick={() => setSelectedDevices([])}
                                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition duration-75 hover:bg-white/4 focus-visible:outline-2 focus-visible:outline-blue-400">
                                    <span className="min-w-0 truncate text-[13px] text-zinc-200">All</span>
                                    <span aria-label="Total clips" className="shrink-0 text-xs text-zinc-500">{allUniqueShots.length.toLocaleString()}</span>
                                </button>
                            </li>
                            {devices.map(([name, count]) => (
                                <li key={name} className="ml-2">
                                    <button
                                        type="button"
                                        aria-label={`Filter clips by device: ${name}`}
                                        aria-pressed={activeDevices.includes(name)}
                                        title={`${name} · ${count} ${count === 1 ? "shot" : "shots"}`}
                                        onClick={() => setSelectedDevices((current) => current.includes(name)
                                            ? current.filter((device) => device !== name) : [...current, name])}
                                        className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition duration-75 focus-visible:outline-2 focus-visible:outline-blue-400 ${activeDevices.includes(name) ? "bg-white/8 hover:bg-white/12" : "hover:bg-white/4"}`}
                                    >
                                        <span aria-hidden="true" className={`grid size-4 shrink-0 place-items-center rounded-sm border ${activeDevices.includes(name) ? "border-zinc-400 bg-white/10 text-zinc-100" : "border-zinc-600"}`}>
                                            {activeDevices.includes(name) && <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3"><path d="m4 10 4 4 8-8" /></svg>}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{name}</span>
                                        <span className="shrink-0 text-xs text-zinc-500">{count}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
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
                        event.dataTransfer.dropEffect = canAddClips ? "copy" : "none";
                    }}
                    onDrop={dropSources}
                    className={`relative flex min-w-0 flex-1 items-center justify-center overflow-y-auto text-center transition ${draggingFolders ? "bg-blue-400/5 outline-2 -outline-offset-4 outline-dashed outline-blue-400/50" : ""}`}
                >
                    {draggingFolders ? (
                        <p className="pointer-events-none text-sm text-blue-300">
                            {canAddClips ? "Drop videos, folders, or a card root to add clips" : "Adding clips is unavailable"}
                        </p>
                    ) : shotCollection.shots.length || shotCollection.scans.length ? (
                        <ShotGrid
                            collection={visibleCollection}
                            newestFirst={newestFirst}
                            onEject={id => requestEject([id])}
                            ejectBusy={ejectBusy}
                            selectedShotIds={selection.editingIds}
                            skippedShotIds={skippedShotIds}
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
                    {selectedShots.length > 1 ? <MultiClipInspector
                        onOrganizationUpdated={receiveShots}
                        onEject={() => requestEject(selectedShots.map(shot => shot.id))} ejectBusy={ejectBusy}
                        shots={orderedShots(selectedShots, newestFirst)} skippedCount={selectedSkippedCount} disabled={selectedLocked}
                        width={inspectorWidth} onResize={setInspectorWidth}
                        onSkipChange={(skipped) => changeSkip(selectedShots.map((shot) => shot.id), skipped)}
                    /> : <ClipInspector
                        onOrganizationUpdated={receiveShots}
                        onEject={() => requestEject(selectedShots.map(shot => shot.id))} ejectBusy={ejectBusy}
                        key={inspectedShot?.id ?? "empty"}
                        shot={inspectedShot}
                        width={inspectorWidth}
                        onResize={setInspectorWidth}
                        skipped={selectedSkippedCount === 1}
                        onSkipChange={(skipped) => changeSkip(selectedShots.map((shot) => shot.id), skipped)}
                    />}
            </main>
            {ejectTargets && <ClipActionDialog key={ejectAction} action={ejectAction} shots={ejectTargets} busy={ejectBusy} error={ejectError}
                onCancel={() => { if (!ejectBusy) setEjectTargets(null); }}
                onConfirm={() => void confirmClipAction()} />}
            {!ejectTargets && skipError && <SourceErrorDialog title="Skip could not be saved" message={skipError} onDismiss={() => setSkipError(null)} />}
            {!ejectTargets && !skipError && workspaceError && <SourceErrorDialog title="Workspace error" message={workspaceError} onDismiss={() => setWorkspaceError(null)} />}
            {!ejectTargets && !skipError && !workspaceError && unavailableDirectories.length > 0 && <DirectoryUnavailableDialog
                directories={unavailableDirectories} onDismiss={() => setUnavailableDirectories([])}
                onEject={ids => { setUnavailableDirectories([]); requestEject(ids); }} />}
            <footer className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-5 border-t border-white/8 px-5 py-3 text-xs text-zinc-500">
                <ApplicationIndicator backend={status} communicationError={communicationError} />
                <IngestFooter selectedShotIds={selectedShots.map(shot => shot.id)} refreshTarget={libraryActions} shots={allUniqueShots} connected={status.state === 'connected'} onRefresh={async () => receiveShots(await window.desktop.getShots())} />
            </footer>
        </div>
    );
}

initializeDesktop();
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
