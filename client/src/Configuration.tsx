import { secondaryButton, primaryButton } from "./buttonStyles";
import type { Ref } from "react";
import { useEffect, useRef, useState } from "react";
import type { AppConfiguration, CacheInventory, LocationChoice } from "../../shared/desktop";
import { errorMessage } from "../../shared/errors";
import type { OptionRemovalPlan, TagField, TagVocabulary } from "../../shared/organization";
import { emptyVocabulary, OPTION_FIELDS } from "../../shared/organization";
import { RemoveOptionsDialog } from "./RemoveOptionsDialog";

import { ClearCacheButton } from "./ClearCacheButton";

function sizeLabel(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const unit = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB", "TB"][unit] ?? "TB"}`;
}

export function Configuration({ libraryActionsRef }: { libraryActionsRef?: Ref<HTMLDivElement> }) {
    const [configuration, setConfiguration] = useState<AppConfiguration | null>(null);
    const [libraryChoice, setLibraryChoice] = useState<LocationChoice | null>(null);
    const [clearLibrary, setClearLibrary] = useState(false);
    const [open, setOpen] = useState(false);
    const [libraryError, setLibraryError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"library" | "cache" | "save" | "review" | null>(null);
    const [removalPlan, setRemovalPlan] = useState<OptionRemovalPlan | null>(null);
    const [vocabulary, setVocabulary] = useState<TagVocabulary | null>(null);
    const [removals, setRemovals] = useState<TagVocabulary>(emptyVocabulary);
    const [optionsError, setOptionsError] = useState<string | null>(null);
    const [vocabularyError, setVocabularyError] = useState<string | null>(null);
    const [cacheInventory, setCacheInventory] = useState<CacheInventory | null>(null);
    const [cacheRecords, setCacheRecords] = useState<number | null>(null);
    const [cacheSummaryError, setCacheSummaryError] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const mutation = useRef(false);
    const requestVersion = useRef(0);
    const hasOptionChanges = OPTION_FIELDS.some((field) => removals[field].length > 0);
    const hasChanges = hasOptionChanges || !!libraryChoice || clearLibrary;

    function showConfiguration() {
        setLibraryChoice(null);
        setClearLibrary(false);
        setLibraryError(null);
        setVocabulary(null);
        setRemovals(emptyVocabulary());
        setOptionsError(null);
        setVocabularyError(null);
        setOpen(true);
    }

    useEffect(() => {
        let disposed = false;
        window.desktop
            .getConfiguration()
            .then((value) => {
                if (!disposed) setConfiguration(value);
            })
            .catch(() => {
                if (!disposed) setLibraryError("Could not load configuration.");
            });
        return () => {
            disposed = true;
        };
    }, []);

    useEffect(() => {
        if (!open) return;
        const element = dialog.current;
        element?.showModal();
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        async function refresh() {
            if (!mutation.current) {
                const version = requestVersion.current;
                const [options] = await Promise.allSettled([window.desktop.getTagVocabulary()]);
                if (!disposed && version === requestVersion.current) {
                    if (options.status === "fulfilled") {
                        setVocabulary(options.value);
                        setVocabularyError(null);
                    } else setVocabularyError("Could not load saved options.");
                }
            }
            if (!disposed) timer = setTimeout(refresh, 2000);
        }
        void window.desktop
            .getConfiguration()
            .then((value) => {
                if (!disposed) setConfiguration(value);
            })
            .catch((error) => {
                if (!disposed) setLibraryError(errorMessage(error, "Could not load configuration."));
            });
        void refresh();
        return () => {
            disposed = true;
            clearTimeout(timer);
            element?.close();
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        let disposed = false;
        setCacheInventory(null);
        setCacheRecords(null);
        setCacheSummaryError(null);
        void Promise.allSettled([window.desktop.getCacheInventory(), window.desktop.getLocalDataSummary()]).then(([files, records]) => {
            if (disposed) return;
            if (files.status === "fulfilled") setCacheInventory(files.value);
            else setCacheSummaryError(errorMessage(files.reason, "Cache summary unavailable."));
            if (records.status === "fulfilled") setCacheRecords(records.value.records);
        });
        return () => { disposed = true; };
    }, [open]);

    async function chooseLibrary() {
        if (mutation.current) return;
        mutation.current = true;
        requestVersion.current++;
        setBusy("library");
        setLibraryError(null);
        try {
            const next = await window.desktop.chooseLibrary();
            if (next) {
                setLibraryChoice(next);
                setClearLibrary(false);
            }
        } catch (error) {
            setLibraryError(errorMessage(error, "Could not choose Library location."));
        } finally {
            mutation.current = false;
            setBusy(null);
        }
    }

    function removeOption(field: TagField, value: string) {
        setRemovals((current) => ({ ...current, [field]: [...new Set([...current[field], value])] }));
    }

    async function saveOptions(reviewToken?: string) {
        if ((mutation.current && !reviewToken) || !hasChanges || (hasOptionChanges && !vocabulary)) return;
        mutation.current = true;
        requestVersion.current++;
        setBusy("save");
        setOptionsError(null);
        let reviewing = false;
        let optionsSaved = false;
        try {
            if (hasOptionChanges && !reviewToken) {
                const plan = await window.desktop.previewConfigurationOptions(removals);
                if (plan.clips.length) {
                    reviewing = true;
                    setRemovalPlan(plan);
                    setBusy("review");
                    return;
                }
                reviewToken = plan.reviewToken;
            }
            if (hasOptionChanges) {
                const result = await window.desktop.saveConfigurationOptions(removals, reviewToken!);
                setVocabulary(result.vocabulary);
                setRemovals(emptyVocabulary());
                optionsSaved = true;
                window.dispatchEvent(new Event("organization-options-changed"));
            }
            let warning: string | undefined;
            let workspaceReset = false;
            if (libraryChoice || clearLibrary) {
                const result = await window.desktop.saveConfigurationLocations({
                    ...(clearLibrary ? { library: null } : libraryChoice ? { library: libraryChoice.token } : {}),
                });
                setConfiguration(result.configuration);
                setLibraryChoice(null);
                setClearLibrary(false);
                window.dispatchEvent(new Event("configuration-changed"));
                warning = result.warning;
                workspaceReset = !!result.workspaceReset;
            }
            if (warning) {
                setOptionsError(warning);
                setRemovalPlan(null);
                return;
            }
            setOpen(false);
            setRemovalPlan(null);
            if (workspaceReset) window.location.reload();
        } catch (error) {
            setRemovalPlan(null);
            setOptionsError(
                (optionsSaved ? "Options were saved. Location changes could not be saved: " : "") +
                    errorMessage(
                        error,
                        "Could not save changes. Wait for any scans to finish, then Save again to review.",
                    ),
            );
        } finally {
            // Keep configuration controls locked while the confirmation is open.
            if (!reviewing) {
                mutation.current = false;
                setBusy(null);
            }
        }
    }

    const buttonStyle = secondaryButton;
    const libraryPath = configuration?.libraryPath;
    const draftLibraryPath = clearLibrary ? null : (libraryChoice?.path ?? libraryPath);
    return (
        <>
            <div className="flex min-w-0 items-center justify-end gap-3">
                <span
                    title={libraryPath ?? undefined}
                    aria-label="Library location"
                    className={`max-w-72 truncate px-2 py-1 text-xs ${libraryPath ? "text-zinc-400" : "text-red-400"}`}
                >
                    {configuration
                        ? (libraryPath ?? "Library Not Set")
                        : libraryError
                          ? "configuration unavailable"
                          : "Loading…"}
                </span>
                <div ref={libraryActionsRef} className="flex shrink-0 items-center" />
                <button
                    aria-label="Configuration"
                    title="Configuration"
                    onClick={showConfiguration}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        className="size-5"
                        aria-hidden="true"
                    >
                        <path
                            strokeLinejoin="round"
                            d="m9.5 3-.6 2.3-1.7 1L5 5.7 2.5 10l1.7 1.7v2L2.5 15.4 5 19.7l2.2-.6 1.7 1 .6 2.3h5l.6-2.3 1.7-1 2.2.6 2.5-4.3-1.7-1.7v-2l1.7-1.7L19 5.7l-2.2.6-1.7-1L14.5 3z"
                            transform="translate(0 -1) scale(1 .96)"
                        />
                        <circle cx="12" cy="11.5" r="3" />
                    </svg>
                </button>
            </div>
            {open && (
                <dialog
                    ref={dialog}
                    aria-labelledby="configuration-title"
                    onCancel={(event) => {
                        event.preventDefault();
                        if (!mutation.current) setOpen(false);
                    }}
                    className="m-auto max-h-[calc(100vh-48px)] w-[720px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl border border-white/10 bg-[#1b2029] p-6 text-zinc-200 shadow-2xl backdrop:bg-black/60"
                >
                    <div className="flex items-center justify-between">
                        <h2 id="configuration-title" className="text-lg font-medium">
                            Configuration
                        </h2>
                        <button
                            autoFocus
                            disabled={!!busy}
                            onClick={() => setOpen(false)}
                            aria-label="Close configuration"
                            className="grid size-8 place-items-center rounded-md text-xl text-zinc-400 hover:bg-white/8 hover:text-white disabled:opacity-40"
                        >
                            ×
                        </button>
                    </div>
                    <div className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-4">
                        <button
                            onClick={() => void chooseLibrary()}
                            disabled={!!busy}
                            className={`whitespace-nowrap ${buttonStyle}`}
                        >
                            {busy === "library" ? "Choosing…" : "Set Library Location"}
                        </button>
                        <div className="flex min-w-0 items-center gap-2">
                            <p
                                aria-label="Configured Library location"
                                role={libraryError ? "alert" : undefined}
                                className={`min-w-0 flex-1 break-all select-text text-xs leading-5 ${draftLibraryPath && !libraryError ? "text-zinc-400" : "text-red-400"}`}
                            >
                                {libraryError ??
                                    draftLibraryPath ??
                                    (clearLibrary
                                        ? "Clears on Save"
                                        : configuration
                                          ? "Library Not Set"
                                          : "Loading…")}
                            </p>
                            {(libraryChoice || configuration?.libraryPath) && (
                                <button
                                    type="button"
                                    aria-label="Clear Library location"
                                    title="Clear Library location on Save"
                                    disabled={!!busy}
                                    onClick={() => {
                                        setClearLibrary(true);
                                        setLibraryChoice(null);
                                        setLibraryError(null);
                                    }}
                                    className="grid size-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-white/8 hover:text-red-300 disabled:opacity-40"
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="mt-6 grid grid-cols-2 gap-4">
                        {OPTION_FIELDS.map((field) => (
                            <section key={field} aria-labelledby={`options-${field}-title`} className="min-w-0">
                                <h3 id={`options-${field}-title`} className="mb-2 text-xs font-medium text-zinc-400">
                                    {{ identity: "Identity", project: "Project", tags: "Tags" }[field]}
                                </h3>
                                <ul
                                    aria-label={`${{ identity: "Identity", project: "Project", tags: "Tags" }[field]} options`}
                                    className="h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/10 py-1"
                                >
                                    {vocabulary?.[field]
                                        .filter((value) => !removals[field].includes(value))
                                        .map((value) => (
                                            <li key={value} className="flex items-start gap-2 px-2 py-1.5 text-xs">
                                                <span className="min-w-0 flex-1 break-all py-0.5 text-zinc-300">
                                                    {value}
                                                </span>
                                                <button
                                                    type="button"
                                                    aria-label={`Delete ${field === "project" ? "Project" : field === "identity" ? "Identity" : "Tag"} option ${value}`}
                                                    disabled={!!busy}
                                                    onClick={() => removeOption(field, value)}
                                                    className="grid size-5 shrink-0 place-items-center rounded text-base text-zinc-500 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                                                >
                                                    ×
                                                </button>
                                            </li>
                                        ))}
                                    {(!vocabulary ||
                                        !vocabulary[field].some((value) => !removals[field].includes(value))) && (
                                        <li className="px-3 py-2 text-xs text-zinc-600">
                                            {vocabulary ? "No entries" : "Loading…"}
                                        </li>
                                    )}
                                </ul>
                            </section>
                        ))}
                    </div>
                    <section className="mt-6" aria-labelledby="cache-summary-title">
                        <h3 id="cache-summary-title" className="text-xs font-medium text-zinc-400">Cache Summary</h3>
                        <p aria-label="Cache summary" className="mt-2 text-xs leading-5 text-zinc-300">
                            {cacheSummaryError ?? (cacheInventory
                                ? `Metadata: ${cacheRecords === null ? "—" : cacheRecords} clips (${sizeLabel(cacheInventory.metadata.bytes)}) · Thumbnails: ${cacheInventory.thumbnails.files} (${sizeLabel(cacheInventory.thumbnails.bytes)}) · Fingerprints: ${cacheInventory.fingerprints.files} (${sizeLabel(cacheInventory.fingerprints.bytes)}) · Proxies: ${cacheInventory.proxies.files} (${sizeLabel(cacheInventory.proxies.bytes)}) · Total: ${sizeLabel(cacheInventory.total.bytes)}`
                                : "Loading…")}
                        </p>
                        <p className="mt-1 text-[11px] leading-5 text-zinc-500">Unused clip data expires after 90 days when the app closes. Saved Identity/Project options stay until Clear Cache.</p>
                    </section>
                    {(optionsError || vocabularyError) && (
                        <p role="alert" className="mt-4 text-xs text-red-300">
                            {optionsError ?? vocabularyError}
                        </p>
                    )}
                    <div className="mt-8 flex items-center justify-end gap-3">
                        <div className="mr-auto flex items-center gap-2">
                            <ClearCacheButton
                                disabled={!!busy}
                                onBusyChange={(value) => {
                                    mutation.current = value;
                                    requestVersion.current++;
                                    setBusy(value ? "cache" : null);
                                }}
                                onReset={() => {
                                    setOpen(false);
                                    window.location.reload();
                                }}
                            />
                            <button
                                type="button"
                                disabled={!!busy}
                                onClick={() =>
                                    void window.desktop
                                        .browseCache()
                                        .catch((error) =>
                                            setOptionsError(errorMessage(error, "Could not open Cache in Finder.")),
                                        )
                                }
                                className={buttonStyle}
                            >
                                Browse Cache
                            </button>
                        </div>
                        <button type="button" disabled={!!busy} onClick={() => setOpen(false)} className={buttonStyle}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            aria-label="Save configuration"
                            disabled={!!busy || !hasChanges || (hasOptionChanges && !vocabulary)}
                            onClick={() => void saveOptions()}
                            className={primaryButton}
                        >
                            {busy === "save" ? "Saving…" : "Save"}
                        </button>
                    </div>
                    {removalPlan && (
                        <RemoveOptionsDialog
                            plan={removalPlan}
                            busy={busy === "save"}
                            onCancel={() => {
                                setRemovalPlan(null);
                                setRemovals(emptyVocabulary());
                                setOptionsError(null);
                                mutation.current = false;
                                setBusy(null);
                            }}
                            onConfirm={() => void saveOptions(removalPlan.reviewToken)}
                        />
                    )}
                </dialog>
            )}
        </>
    );
}
