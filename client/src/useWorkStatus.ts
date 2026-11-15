import { useCallback, useEffect, useState } from 'react';
import type { IngestStatus } from '../../shared/ingestion';

// One queue subscription for the workspace, independent of the selected tab.
export function useWorkStatus(connected: boolean) {
    const [status, setStatus] = useState<IngestStatus>({
        revision: 0, active: false, stopping: false, position: 0, total: 0, errors: [],
    });
    const receiveStatus = useCallback((next: IngestStatus) => {
        setStatus(current => next.revision >= current.revision ? next : current);
    }, []);
    const dismissError = useCallback((eventId: string) => {
        setStatus(current => ({ ...current, errors: current.errors.filter(error => error.eventId !== eventId) }));
    }, []);
    useEffect(() => {
        if (!connected || !window.desktop.getIngestStatus) return;
        let disposed = false;
        const receive = (next: IngestStatus) => { if (!disposed) receiveStatus(next); };
        // Subscribe first; revisions reject an initial read that arrives after a newer event.
        const unsubscribe = window.desktop.onIngestChanged(receive);
        void window.desktop.getIngestStatus().then(receive).catch(() => undefined);
        return () => { disposed = true; unsubscribe(); };
    }, [connected, receiveStatus]);
    return { status, receiveStatus, dismissError };
}
