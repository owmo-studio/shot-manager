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
    constructor(private queue: WriteQueue, private delayMs = 500) {}

    schedule(key: string, operation: () => Promise<unknown>): Promise<unknown> {
        if (this.batch && this.batch.key !== key) void this.flush();
        const batch = this.batch ??= { key, operation, waiters: [] };
        batch.operation = operation;
        clearTimeout(batch.timer);
        const result = new Promise((resolve, reject) => batch.waiters.push({ resolve, reject }));
        batch.timer = setTimeout(() => { void this.flush(); }, this.delayMs);
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
            error => { for (const waiter of batch.waiters) waiter.reject(error); },
        );
    }
}
