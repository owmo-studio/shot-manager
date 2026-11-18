import { inspectorButton, inspectorDangerButton } from './buttonStyles';
import type { StoppableTransfer } from '../../shared/ingestion';

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

export function EjectButton({ count, disabled, onClick }: { count: number; disabled: boolean; onClick: () => void }) {
    return <button type="button" aria-label={`Eject selected ${count === 1 ? "clip" : "clips"}`}
        title="Eject from workspace" disabled={!count || disabled} onClick={onClick} className={inspectorDangerButton}>
        <EjectIcon className="size-3.5" />
    </button>;
}

export function StopClipButton({ count, busy, kind, onClick }: {
    count: number; busy: boolean; kind: StoppableTransfer; onClick: () => void;
}) {
    return <button type="button" aria-label={`Stop selected ${count === 1 ? "clip" : "clips"}`}
        title={kind === 'sync' ? 'Stop selected Exports' : 'Stop selected Commits'} disabled={!count || busy} onClick={onClick} className={inspectorButton}>
        <StopIcon className="size-3.5" />
    </button>;
}
