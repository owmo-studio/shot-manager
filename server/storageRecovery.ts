// Shared recovery window for all storage checks; not a user setting.
export const DEFAULT_STORAGE_WAIT_SECONDS = 10;

export interface StorageRetryInfo {
    attempt: number;
    elapsedMs: number;
    error: string;
    code?: string;
}

const transientCodes = new Set([
    'EAGAIN', 'EBUSY', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH', 'EINTR', 'EIO',
    'ENETDOWN', 'ENETUNREACH', 'ENOENT', 'ENOTDIR', 'ENXIO', 'ESTALE', 'ETIMEDOUT',
]);

export function storageWaitSeconds(value: unknown) {
    if (value === undefined) return DEFAULT_STORAGE_WAIT_SECONDS;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('Storage response wait must be a non-negative whole number of seconds.');
    }
    return value;
}

function errorCode(error: unknown) {
    if (!error || typeof error !== 'object') return undefined;
    if ('code' in error && typeof error.code === 'string') return error.code;
    if ('cause' in error) return errorCode(error.cause);
    return undefined;
}

export function isTransientStorageFailure(error: unknown) {
    const code = errorCode(error);
    if (code) return transientCodes.has(code);
    const message = error instanceof Error ? error.message : String(error);
    return /(?:Library|Export|Cache).*(?:unavailable|missing|not mounted)|(?:storage|volume|folder).*(?:unavailable|missing|not mounted)/i.test(message);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
    if (!signal) return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
    const activeSignal = signal;
    if (activeSignal.aborted) return Promise.reject(activeSignal.reason ?? new Error('Operation stopped.'));
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, milliseconds);
        const abort = () => { clearTimeout(timer); activeSignal.removeEventListener('abort', abort); reject(activeSignal.reason ?? new Error('Operation stopped.')); };
        function done() { activeSignal.removeEventListener('abort', abort); resolve(); }
        activeSignal.addEventListener('abort', abort, { once: true });
    });
}

export async function withStorageRecovery<T>(operation: () => Promise<T>, waitSeconds: number,
    signal?: AbortSignal, onRetry?: (info: StorageRetryInfo) => void) {
    const wait = storageWaitSeconds(waitSeconds);
    const deadline = Date.now() + wait * 1000;
    let attempt = 0;
    let pause = 250;
    while (true) {
        signal?.throwIfAborted();
        try { return await operation(); }
        catch (error) {
            if (!isTransientStorageFailure(error) || Date.now() >= deadline) throw error;
            attempt++;
            const elapsedMs = Math.max(0, Date.now() - (deadline - wait * 1000));
            onRetry?.({ attempt, elapsedMs, error: error instanceof Error ? error.message : String(error), code: errorCode(error) });
            await abortableDelay(Math.min(pause, Math.max(1, deadline - Date.now())), signal);
            pause = Math.min(2000, pause * 2);
        }
    }
}
