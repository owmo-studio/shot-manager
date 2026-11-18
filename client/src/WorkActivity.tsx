import type { IngestStatus, WorkQueue } from '../../shared/ingestion';
import { createPortal } from 'react-dom';

const controlStyle = 'relative grid size-8 shrink-0 place-items-center rounded-md text-zinc-400 transition focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40';

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        className={`size-5 ${spinning ? 'motion-safe:animate-spin' : ''}`}>
        <path d="M3 11a9 9 0 0 1 15.36-6.36L21 7M21 3v4h-4M21 13a9 9 0 0 1-15.36 6.36L3 17M7 17H3v4" />
    </svg>;
}

export function WorkActivity({ status, disabled, checking, onRefresh, onQueueControl, busyQueues, controlTarget }: {
    status: IngestStatus; disabled: boolean; checking: boolean; onRefresh: () => void;
    onQueueControl: (queue: WorkQueue, pause: boolean) => void;
    busyQueues: ReadonlySet<WorkQueue>;
    controlTarget: HTMLDivElement | null;
}) {
    const proxies = status.tasks?.proxiesRemaining ?? 0;
    const commits = (status.tasks?.transfersRemaining ?? 0) + (status.metadataPending ?? 0);
    const exports = status.tasks?.syncsRemaining ?? 0;
    const queues = [
        { queue: 'proxy', kind: 'proxy', label: 'Proxies', progressLabel: 'Proxy progress', count: proxies,
            current: status.work?.current, paused: status.work?.paused || status.pausedQueues?.proxy,
            working: status.work?.encoding, color: 'bg-yellow-400' },
        { queue: 'commit', kind: 'commit', label: 'Commits', progressLabel: 'Commit progress', count: commits,
            current: status.current, paused: status.pausedQueues?.commit, working: !!status.current || status.metadataActive, color: 'bg-blue-500' },
        { queue: 'sync', kind: 'export', label: 'Exports', progressLabel: 'Export progress', count: exports,
            current: status.exportCurrent, paused: status.pausedQueues?.sync, working: !!status.exportCurrent, color: 'bg-emerald-400' },
    ] as const;
    const summary = `${proxies} ${proxies === 1 ? 'proxy' : 'proxies'}, ${commits} ${commits === 1 ? 'commit' : 'commits'}, ${exports} ${exports === 1 ? 'export' : 'exports'}`;
    return <div data-work-progress data-work-active={queues.some(queue => queue.working)} data-ingest-progress={status.active ? '' : undefined}
        role="status" aria-label={summary} className="col-start-2 row-start-1 text-xs tabular-nums">
        <div className="grid w-[min(560px,46vw)] grid-cols-3 gap-6">
            {queues.map(({ queue, kind, label, progressLabel, count, current, paused, working, color }) => {
                const stop = !paused && (working || count > 0);
                const spinning = stop && working;
                const action = stop ? `Stop ${label}` : paused ? `Resume ${label}` : `Refresh ${label}`;
                const percent = Math.max(0, Math.min(100, current?.percent ?? 0));
                return <div key={queue} data-work-kind={kind} data-active={count > 0} data-paused={!!paused} className="flex min-w-0 items-center gap-2">
                    <button type="button" aria-label={action} title={action} aria-busy={busyQueues.has(queue)}
                        disabled={disabled || status.stopping || busyQueues.has(queue) || (!stop && !paused && (queue !== 'proxy' || !status.libraryPath))}
                        onClick={() => onQueueControl(queue, !!stop)}
                        className={`group/queue ${controlStyle} ${stop ? 'enabled:hover:bg-red-500/10 enabled:hover:text-red-400' : 'enabled:hover:bg-white/8 enabled:hover:text-zinc-100'}`}>
                        {spinning && <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                            className="size-5 motion-safe:animate-spin group-enabled/queue:group-hover/queue:opacity-0 group-focus-visible/queue:opacity-0">
                            <circle cx="12" cy="12" r="8" opacity=".25" /><path d="M12 4a8 8 0 0 1 8 8" />
                        </svg>}
                        {stop ? <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"
                            className={`absolute size-5 ${spinning ? 'opacity-0 group-enabled/queue:group-hover/queue:opacity-100 group-focus-visible/queue:opacity-100' : ''}`}>
                            <rect x="6" y="6" width="12" height="12" rx="1" />
                        </svg> : <RefreshIcon />}
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                            <span className={`text-[11px] ${count > 0 ? 'text-zinc-200' : 'text-zinc-600'}`}>{label}</span>
                            <span className={`font-medium ${count > 0 ? 'text-white' : 'text-zinc-600'}`}>{count}</span>
                        </div>
                        <div role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
                            aria-valuetext={paused ? 'Paused' : working ? `${percent}%` : count > 0 ? 'Waiting' : 'Idle'}
                            className="h-1.5 overflow-hidden rounded-full bg-white/8">
                            <div key={current?.id ?? 'idle'} className={`h-full rounded-full motion-safe:transition-[width] ${color}`} style={{ width: `${percent}%` }} />
                        </div>
                    </div>
                </div>;
            })}
        </div>
        {controlTarget && createPortal(<button type="button" aria-label="Refresh Library" title="Refresh Library"
            aria-busy={checking} disabled={disabled || !status.libraryPath || checking}
            onClick={onRefresh} className={`${controlStyle} enabled:hover:bg-white/8 enabled:hover:text-zinc-100`}>
            <RefreshIcon spinning={checking} />
        </button>, controlTarget)}
    </div>;
}
