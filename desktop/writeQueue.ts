// Keeps accepted saves ordered and alive independently of renderer lifetime.
export class WriteQueue {
    private pending: Promise<unknown> = Promise.resolve();
    run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation);
        this.pending = result.catch(() => undefined);
        return result;
    }
    drain() { return this.pending; }
}

// Collect edits for the same selection without leaving unsaved text in the renderer.
export class DebouncedWrites {
    private batch?: {
        key: string;
        operation: () => Promise<unknown>;
        waiters: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[];
        timer?: ReturnType<typeof setTimeout>;
    };
    constructor(private queue: Pick<WriteQueue, 'run' | 'drain'>, private delayMs = 500) {}

    schedule(key: string, operation: () => Promise<unknown>): Promise<unknown> {
        if (this.batch && this.batch.key !== key) void this.flush().catch(() => undefined);
        const batch = this.batch ??= { key, operation, waiters: [] };
        batch.operation = operation;
        clearTimeout(batch.timer);
        const result = new Promise((resolve, reject) => batch.waiters.push({ resolve, reject }));
        batch.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, this.delayMs);
        batch.timer.unref();
        return result;
    }

    flush(): Promise<void> {
        const batch = this.batch;
        if (!batch) return this.queue.drain().then(() => undefined);
        this.batch = undefined;
        clearTimeout(batch.timer);
        return this.queue.run(batch.operation).then(
            value => { for (const waiter of batch.waiters) waiter.resolve(value); },
            error => { for (const waiter of batch.waiters) waiter.reject(error); throw error; },
        );
    }
}

// Retain accepted draft commands in the main process until saved or explicitly discarded.
// Later commands wait behind a failed command so a retry cannot overwrite newer edits.
export class RetainedWrites {
    private entries: { operation: () => Promise<unknown>; failed: boolean; error?: string }[] = [];
    constructor(private queue: WriteQueue, private changed: () => void = () => undefined) {}

    status() {
        return { pending: this.entries.filter(entry => !entry.failed).length,
            failed: this.entries.filter(entry => entry.failed).length,
            error: this.entries.find(entry => entry.failed)?.error };
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        const entry = { operation, failed: false, error: undefined as string | undefined };
        this.entries.push(entry);
        this.changed();
        return this.queue.run(async () => {
            try {
                if (this.entries.slice(0, this.entries.indexOf(entry)).some(item => item.failed)) {
                    throw new Error('An earlier change could not be saved. Retry unsaved changes first.');
                }
                const result = await operation();
                this.entries.splice(this.entries.indexOf(entry), 1);
                return result;
            } catch (error) {
                entry.failed = true;
                entry.error = error instanceof Error ? error.message : 'Could not save this change.';
                throw error;
            } finally { this.changed(); }
        });
    }

    async drain() {
        await this.queue.drain();
        if (this.entries.length) throw new Error('Unsaved changes remain. Retry them before continuing.');
    }

    retry() {
        return this.queue.run(async () => {
            for (const entry of [...this.entries].filter(item => item.failed)) {
                entry.failed = false;
                this.changed();
                try {
                    await entry.operation();
                    this.entries.splice(this.entries.indexOf(entry), 1);
                } catch (error) {
                    entry.failed = true;
                    entry.error = error instanceof Error ? error.message : 'Could not save this change.';
                    throw error;
                } finally { this.changed(); }
            }
        });
    }

    discard() {
        if (this.entries.some(entry => !entry.failed)) throw new Error('Wait for pending saves before discarding failed changes.');
        this.entries = [];
        this.changed();
    }
}
