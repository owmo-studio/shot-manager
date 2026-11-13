export function EjectIcon({ className = "size-4" }: { className?: string }) {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
        <path d="m5 14 7-9 7 9H5Z" />
        <path d="M5 19h14" />
    </svg>;
}

export function StopIcon({ className = "size-4" }: { className?: string }) {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className={className}>
        <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>;
}

export function EjectButton({ count, busy, cancel = false, onClick }: { count: number; busy: boolean; cancel?: boolean; onClick: () => void }) {
    const action = cancel ? "Stop" : "Eject";
    const Icon = cancel ? StopIcon : EjectIcon;
    return <button type="button" aria-label={`${action} selected ${count === 1 ? "clip" : "clips"}`}
        title={cancel ? "Stop selected Commits" : "Eject from workspace"} disabled={!count || busy} onClick={onClick}
        className="flex h-7 items-center gap-1.5 rounded-md border border-white/15 bg-white/8 px-2 text-[10px] font-medium text-zinc-200 transition enabled:hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-40">
        <Icon className="size-3.5" />{busy ? "Working…" : action}
    </button>;
}
