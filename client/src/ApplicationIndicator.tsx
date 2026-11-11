import type { ApplicationStatus, BackendStatus } from '../../shared/desktop';

export function applicationStatus(backend: BackendStatus, communicationError: boolean): ApplicationStatus {
    return backend.state !== 'connected'
        ? { level: backend.state === 'unavailable' ? 'error' : 'warning', message: backend.state === 'unavailable' ? 'Backend Unavailable' : 'Starting…', detail: backend.message }
        : communicationError
            ? { level: 'error', message: 'Communication Error', detail: 'Could not refresh sources or clips. The app will retry shortly.' }
            : backend.application ?? { level: 'warning', message: 'Checking Status' };
}

export function ApplicationIndicator({ backend, communicationError }: { backend: BackendStatus; communicationError: boolean }) {
    const status = applicationStatus(backend, communicationError);
    return <div role="status" aria-live="polite" aria-atomic="true" aria-label="Application status" data-application-level={status.level}
        title={status.detail ?? status.message} className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${status.level === 'ready' ? 'bg-emerald-400' : status.level === 'warning' ? 'bg-amber-400' : 'bg-red-400'}`} />
        <span className="truncate">{status.message}</span>
    </div>;
}
