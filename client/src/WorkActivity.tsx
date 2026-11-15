import type { IngestStatus } from '../../shared/ingestion';
import { createPortal } from 'react-dom';

export function WorkActivity({ status, disabled, checking, onRefresh, onStop, controlTarget }: {
    status: IngestStatus; disabled: boolean; checking: boolean; onRefresh: () => void; onStop: () => void;
    controlTarget: HTMLDivElement | null;
}) {
    const hasWork = status.active || !!status.work?.encoding || !!(status.work && !status.work.paused && status.work.queued > 0);
    const proxies = status.tasks?.proxiesRemaining ?? 0;
    const commits = status.tasks?.transfersRemaining ?? 0;
    const exports = status.tasks?.syncsRemaining ?? 0;
    const proxyProgress = proxies > 0 ? status.work?.current : undefined;
    const percent = (value?: number) => Math.max(0, Math.min(100, value ?? 0));
    const canStop = hasWork && !disabled && !status.stopping;
    const summary = `${proxies} ${proxies === 1 ? 'proxy' : 'proxies'}, ${commits} ${commits === 1 ? 'commit' : 'commits'}, ${exports} ${exports === 1 ? 'export' : 'exports'}`;
    return <div data-work-progress data-work-active={hasWork} data-ingest-progress={status.active ? '' : undefined}
        role="status" aria-label={summary}
        className="col-start-2 row-start-1 flex items-center gap-4 text-xs tabular-nums">
        <div className="grid w-[min(480px,38vw)] grid-cols-3 gap-4">
            <div data-work-kind="proxy" data-active={proxies > 0} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span className={`text-[11px] ${proxies > 0 ? 'text-zinc-200' : 'text-zinc-600'}`}>Proxies</span>
                    <span className={`font-medium ${proxies > 0 ? 'text-white' : 'text-zinc-600'}`}>{proxies}</span>
                </div>
                <div role="progressbar" aria-label="Proxy progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(proxyProgress?.percent)}
                    aria-valuetext={proxyProgress ? `Encoding: ${percent(proxyProgress.percent)}%` : proxies > 0 ? 'Waiting to encode' : 'No proxies queued'}
                    className="h-1.5 overflow-hidden rounded-full bg-white/8">
                    <div key={proxyProgress?.id ?? 'idle'} className="h-full rounded-full bg-yellow-400 motion-safe:transition-[width]" style={{ width: `${percent(proxyProgress?.percent)}%` }} />
                </div>
            </div>
            {([
                { kind: 'commit', label: 'Commits', count: commits, current: status.current, color: 'bg-blue-500' },
                { kind: 'export', label: 'Exports', count: exports, current: status.exportCurrent, color: 'bg-emerald-400' },
            ] as const).map(({ kind, label, count, current, color }) => {
                const active = count > 0 ? current : undefined;
                return <div key={kind} data-work-kind={kind} data-active={count > 0} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <span className={`text-[11px] ${count > 0 ? 'text-zinc-200' : 'text-zinc-600'}`}>{label}</span>
                        <span className={`font-medium ${count > 0 ? 'text-white' : 'text-zinc-600'}`}>{count}</span>
                    </div>
                    <div role="progressbar" aria-label={kind === 'commit' ? 'Commit progress' : 'Export progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(active?.percent)}
                        aria-valuetext={active ? `${kind === 'commit' ? 'Committing' : 'Exporting'} ${active.filename}: ${percent(active.percent)}%` : count > 0 ? 'Waiting to transfer' : `No ${label.toLowerCase()} queued`}
                        className="h-1.5 overflow-hidden rounded-full bg-white/8">
                        <div key={active?.id ?? 'idle'} className={`h-full rounded-full motion-safe:transition-[width] ${color}`} style={{ width: `${percent(active?.percent)}%` }} />
                    </div>
                </div>;
            })}
        </div>
        {controlTarget && createPortal(<button type="button" aria-label={hasWork ? 'Stop processing' : 'Refresh assets'}
            aria-busy={checking || status.stopping}
            title={hasWork ? 'Stop processing' : checking ? 'Checking assets…' : 'Refresh assets and resume background work'}
            disabled={disabled || status.stopping || (!hasWork && (!status.libraryPath || checking))}
            onClick={hasWork ? onStop : onRefresh}
            className={`group/work-control relative grid size-8 shrink-0 place-items-center rounded-md text-zinc-400 transition focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40 ${hasWork ? 'enabled:hover:bg-red-500/10 enabled:hover:text-red-400 enabled:focus-visible:text-red-400' : 'enabled:hover:bg-white/8 enabled:hover:text-zinc-100'}`}>
            {hasWork ? <>
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                    className={`size-5 motion-safe:animate-spin ${canStop ? 'group-hover/work-control:opacity-0 group-focus-visible/work-control:opacity-0' : ''}`}>
                    <circle cx="12" cy="12" r="8" opacity=".25" /><path d="M12 4a8 8 0 0 1 8 8" />
                </svg>
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"
                    className={`absolute size-5 opacity-0 ${canStop ? 'group-hover/work-control:opacity-100 group-focus-visible/work-control:opacity-100' : ''}`}>
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
            </> : <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                className={`size-5 ${checking ? 'motion-safe:animate-spin' : ''}`}>
                <path d="M3 11a9 9 0 0 1 15.36-6.36L21 7M21 3v4h-4M21 13a9 9 0 0 1-15.36 6.36L3 17M7 17H3v4" />
            </svg>}
        </button>, controlTarget)}
    </div>;
}
