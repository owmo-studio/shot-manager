export interface ErrorDetails {
    message: string;
    code: string;
    outcome: 'failed' | 'unknown';
    status?: number;
}

export type IPCResult<T> = { ok: true; value: T } | { ok: false; error: ErrorDetails };

export class AppError extends Error implements ErrorDetails {
    constructor(message: string, public code: string, public outcome: 'failed' | 'unknown' = 'failed', public status?: number) {
        super(message);
    }
}

export function errorDetails(error: unknown): ErrorDetails {
    if (error instanceof AppError) return { message: error.message, code: error.code, outcome: error.outcome, status: error.status };
    return { message: error instanceof Error ? error.message : 'An unexpected error occurred.', code: 'APPLICATION_ERROR', outcome: 'failed' };
}

export function errorMessage(error: unknown, fallback: string) {
    return error instanceof AppError ? error.message : fallback;
}
