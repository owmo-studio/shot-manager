import { useEffect, useState } from 'react';
import type { SaveStatus } from '../../shared/desktop';

// App-level visibility survives inspector changes; retained commands live in Electron main.
export function SaveStatusBanner() {
    const [status, setStatus] = useState<SaveStatus>({ pending: 0, failed: 0 });
    const [retrying, setRetrying] = useState(false);
    useEffect(() => {
        let disposed = false, receivedEvent = false;
        const unsubscribe = window.desktop.onSaveStatusChanged(value => {
            receivedEvent = true;
            setStatus(value);
        });
        window.desktop.getSaveStatus().then(value => {
            if (!disposed && !receivedEvent) setStatus(value);
        }).catch(() => undefined);
        return () => { disposed = true; unsubscribe(); };
    }, []);
    useEffect(() => {
        document.body.inert = !!status.closing;
        return () => { document.body.inert = false; };
    }, [status.closing]);
    if (status.closing) return <div role="status" className="border-b border-white/10 px-6 py-3 text-xs text-zinc-400">Finishing accepted changes before closing…</div>;
    if (!status.failed) return null;
    return <div role="alert" className="flex items-center gap-4 border-b border-red-400/20 bg-red-500/10 px-6 py-3 text-xs text-red-200">
        <span className="flex-1">{status.failed} unsaved clip {status.failed === 1 ? 'change' : 'changes'} retained. {status.error}</span>
        <button type="button" disabled={retrying} aria-label="Retry unsaved changes" className="shrink-0 underline disabled:opacity-40"
            onClick={async () => {
                setRetrying(true);
                try { await window.desktop.retryOrganizationSaves(); window.dispatchEvent(new Event('organization-saves-retried')); }
                catch { /* The retained failure remains visible through save-status events. */ }
                finally { setRetrying(false); }
            }}>{retrying ? 'Retrying…' : 'Retry saves'}</button>
    </div>;
}
