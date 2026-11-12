export function EjectIcon({ className = "size-4" }: { className?: string }) {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
        <path d="m5 14 7-9 7 9H5Z" />
        <path d="M5 19h14" />
    </svg>;
}

export function EjectButton({ count, busy, onClick }: { count: number; busy: boolean; onClick: () => void }) {
    return <button type="button" aria-label={count === 1 ? "Eject selected clip" : "Eject selected clips"}
        title="Remove from the workspace; keep files and cached information" disabled={!count || busy} onClick={onClick}
        className="flex h-7 items-center gap-1.5 rounded-md border border-white/15 bg-white/8 px-2 text-[10px] font-medium text-zinc-200 transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40">
        <EjectIcon className="size-3.5" />{busy ? "Ejecting…" : count > 1 ? `Eject ${count}` : "Eject"}
    </button>;
}
