import type { IngestStatus } from '../shared/ingestion';

export type QueueTaskKind = 'proxy' | 'transfer' | 'sync';
export interface QueueTask { kind: QueueTaskKind; percent: number }
export type QueueProgress = NonNullable<IngestStatus['tasks']>;

/**
 * Reconcile the session task ledger with work that is still pending. Completed
 * tasks are retained until the current session goes idle, while cancelled or
 * failed unfinished tasks disappear from the remaining count.
 */
export function reconcileQueueTasks(
    previous: ReadonlyMap<string, QueueTask>,
    pending: ReadonlyMap<string, QueueTask>,
    ready: ReadonlySet<string>,
): Map<string, QueueTask> {
    const next = new Map(previous);
    if (![...next.values()].some(task => task.percent < 100) && [...pending.keys()].some(key => !next.has(key))) next.clear();
    for (const [key, task] of next) {
        if (task.kind === 'proxy' && ready.has(key)) next.set(key, { ...task, percent: 100 });
        else if (task.percent < 100 && !pending.has(key)) next.delete(key);
    }
    for (const [key, task] of pending) {
        next.set(key, { ...task, percent: Math.max(task.percent, next.get(key)?.percent ?? 0) });
    }
    return next;
}

export function summarizeQueueTasks(tasks: ReadonlyMap<string, QueueTask>): QueueProgress {
    const values = [...tasks.values()];
    const completed = values.filter(task => task.percent === 100).length;
    const syncs = values.filter(task => task.kind === 'sync');
    return {
        completed,
        total: values.length,
        percent: values.length ? Math.min(completed === values.length ? 100 : 99, Math.floor(values.reduce((sum, task) => sum + task.percent, 0) / values.length)) : 0,
        proxiesRemaining: values.filter(task => task.kind === 'proxy' && task.percent < 100).length,
        transfersRemaining: values.filter(task => task.kind === 'transfer' && task.percent < 100).length,
        syncsRemaining: values.filter(task => task.kind === 'sync' && task.percent < 100).length,
        sync: {
            completed: syncs.filter(task => task.percent === 100).length,
            total: syncs.length,
            percent: syncs.length ? Math.floor(syncs.reduce((sum, task) => sum + task.percent, 0) / syncs.length) : 0,
        },
    };
}
