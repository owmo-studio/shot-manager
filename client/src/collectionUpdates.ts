import type { ShotCollection } from '../../shared/shots';

// Coalesce notices and allow only one snapshot request at a time.
export class CollectionUpdates {
    private wanted = -1;
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
    private disposed = false;
    constructor(private read: () => Promise<ShotCollection>, private receive: (collection: ShotCollection) => void,
        private currentRevision: () => number, private delayMs = 250) {}

    notify(revision: number) {
        this.wanted = Math.max(this.wanted, revision);
        this.schedule(this.delayMs);
    }

    private schedule(delay: number) {
        if (this.disposed || this.running || this.timer || this.wanted <= this.currentRevision()) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
    }

    private async refresh() {
        if (this.disposed || this.wanted <= this.currentRevision()) return;
        this.running = true;
        let failed = false;
        try {
            const collection = await this.read();
            if (!this.disposed) this.receive(collection);
        } catch { failed = true; } // Polling also repairs missed updates; retry this notice as well.
        finally { this.running = false; this.schedule(failed ? 1000 : this.delayMs); }
    }

    dispose() { this.disposed = true; clearTimeout(this.timer); }
}
