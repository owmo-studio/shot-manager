import { AppError } from '../shared/errors';

// Reads have a deadline. Mutations wait for a response rather than pretending a client timeout cancels a save.
export async function requestBackend<T = unknown>(baseURL: string | null, token: string, path: string,
    options: RequestInit = {}, fetcher: typeof fetch = fetch, readTimeoutMs = 15000): Promise<T> {
    if (!baseURL) throw new AppError('Backend is not ready.', 'BACKEND_UNAVAILABLE');
    const mutation = !['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase());
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const deadline = mutation ? undefined : AbortSignal.timeout(readTimeoutMs);
    const signal = deadline && options.signal ? AbortSignal.any([options.signal, deadline]) : deadline ?? options.signal;
    let response: Response;
    try {
        response = await fetcher(`${baseURL}${path}`, { ...options, headers, signal, redirect: 'error' });
    } catch {
        throw new AppError(mutation
            ? 'The backend connection was lost. This operation may already have completed; its outcome is unknown.'
            : signal?.aborted ? 'The backend read timed out. Please try again.' : 'Could not contact the backend.',
        mutation ? 'MUTATION_OUTCOME_UNKNOWN' : signal?.aborted ? 'READ_TIMEOUT' : 'BACKEND_CONNECTION', mutation ? 'unknown' : 'failed');
    }
    let body: unknown;
    try { body = response.status === 204 ? undefined : await response.json(); }
    catch {
        throw new AppError('The backend returned an unreadable response.', 'INVALID_BACKEND_RESPONSE', mutation ? 'unknown' : 'failed', response.status);
    }
    if (!response.ok) {
        const data = body as { message?: unknown; code?: unknown } | null;
        const unknown = mutation && response.status >= 500;
        const message = typeof data?.message === 'string' ? data.message : `Backend request failed (${response.status}).`;
        throw new AppError(unknown ? `${message} This operation may already have completed; its outcome is unknown.` : message,
            typeof data?.code === 'string' ? data.code : `HTTP_${response.status}`, unknown ? 'unknown' : 'failed', response.status);
    }
    return body as T;
}
