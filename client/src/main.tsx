import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BackendStatus, ImportSource } from "../../shared/desktop";
import { SourceListItem, sourcePresentation } from "./SourceListItem";
import "./styles.css";

function App() {
    const [status, setStatus] = useState<BackendStatus>({ state: "starting", message: "Starting backend…" });
    const [sources, setSources] = useState<ImportSource[]>([]);
    const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
    const [sourcesLoaded, setSourcesLoaded] = useState(false);
    const [choosingSource, setChoosingSource] = useState(false);
    const [sourceError, setSourceError] = useState<string | null>(null);
    const sourceRevision = useRef(0);
    const sourceMutation = useRef(false);
    const activeSource = sources.find((source) => source.id === activeSourceId);

    async function addSource() {
        if (sourceMutation.current) return;
        sourceMutation.current = true;
        sourceRevision.current += 1;
        setChoosingSource(true);
        setSourceError(null);
        try {
            const source = await window.desktop.chooseSource();
            if (!source) return;
            setSources((current) => [...current.filter((item) => item.path !== source.path), source]);
            setActiveSourceId(source.id);
        } catch {
            setSourceError("Could not inspect this source. Check that it is connected and readable, then try again.");
        } finally {
            setChoosingSource(false);
            sourceRevision.current += 1;
            sourceMutation.current = false;
        }
    }

    async function removeSource(id: string) {
        if (sourceMutation.current) return;
        sourceMutation.current = true;
        sourceRevision.current += 1;
        setSourceError(null);
        try {
            await window.desktop.removeSource(id);
            setSources((current) => current.filter((source) => source.id !== id));
            setActiveSourceId((current) => (current === id ? null : current));
        } catch {
            setSourceError("Could not remove the source. Please try again.");
        } finally {
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
                        if (!disposed && revision === sourceRevision.current) {
                            setSources(currentSources);
                            setSourcesLoaded(true);
                            setActiveSourceId((current) =>
                                currentSources.some((source) => source.id === current)
                                    ? current
                                    : (currentSources[0]?.id ?? null),
                            );
                        }
                    } catch {
                        if (!disposed) setSourceError("Could not refresh sources. The app will retry shortly.");
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
                            disabled={!sourcesLoaded || choosingSource || status.state !== "connected"}
                            className="rounded-md border border-white/10 bg-white/4 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40"
                        >
                            {choosingSource ? "Choosing…" : "+ Add Source"}
                        </button>
                    </div>
                    {sourceError && (
                        <p role="alert" className="mt-4 text-xs leading-5 text-red-300">
                            {sourceError}
                        </p>
                    )}
                    {sources.length === 0 && !sourceError && (
                        <p className="mt-4 text-xs leading-6 text-zinc-500">
                            {sourcesLoaded ? "Add a folder or SD Card to get started." : "Loading sources…"}
                        </p>
                    )}
                    <ul aria-label="Import sources" className="mt-4 space-y-2">
                        {sources.map((source) => (
                            <SourceListItem
                                key={source.id}
                                source={source}
                                selected={source.id === activeSourceId}
                                onSelect={() => setActiveSourceId(source.id)}
                                onRemove={() => void removeSource(source.id)}
                            />
                        ))}
                    </ul>
                </aside>
                <section className="flex flex-1 items-center justify-center p-10 text-center">
                    <div className="max-w-md">
                        <div
                            className="mx-auto mb-6 grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/4 text-2xl text-zinc-500"
                            aria-hidden="true"
                        >
                            ＋
                        </div>
                        <h2 className="text-xl font-medium tracking-tight">
                            {activeSource ? sourcePresentation(activeSource).name : "Your workspace is ready"}
                        </h2>
                        <p className="mt-3 leading-6 text-zinc-500">
                            {activeSource
                                ? !activeSource.available
                                    ? "This source is currently inaccessible."
                                    : activeSource.type === "sony"
                                      ? "Sony card structure recognized. Shot browsing will be added next."
                                      : "Ready to inspect as a folder of videos. Shot browsing will be added next."
                                : "Add a source to begin building your workspace."}
                        </p>
                        {activeSource && <p className="mt-4 break-all text-xs text-zinc-500">{activeSource.path}</p>}
                        <p className="mt-6 text-xs text-zinc-600">
                            Sources last for this session. Detection reads folders and camera metadata only; media is
                            never modified.
                        </p>
                    </div>
                </section>
            </main>
            <footer className="flex items-center justify-between border-t border-white/8 px-5 py-3 text-xs text-zinc-500">
                <div role="status" className="flex items-center gap-2">
                    <span
                        className={`size-1.5 rounded-full ${status.state === "connected" ? "bg-emerald-400" : status.state === "starting" ? "bg-amber-400" : "bg-red-400"}`}
                    />
                    {status.state === "connected" ? "Backend connected" : status.message}
                </div>
                <span>Dummy data only · No active operations</span>
            </footer>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
