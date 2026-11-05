import type { DesktopAPI } from '../../shared/desktop';
import { AppError } from '../../shared/errors';
import type { IPCResult } from '../../shared/errors';

export function initializeDesktop() {
    const bridge = window.desktopBridge;
    if (!bridge) return; // Isolated renderer fixtures provide their own DesktopAPI.
    const desktop = Object.fromEntries(Object.entries(bridge).map(([name, method]) => {
        if (name.startsWith('on')) return [name, method];
        const invoke = method as (...args: unknown[]) => Promise<IPCResult<unknown>>;
        return [name, async (...args: unknown[]) => {
            const result = await invoke(...args);
            if (!result.ok) throw new AppError(result.error.message, result.error.code, result.error.outcome, result.error.status);
            return result.value;
        }];
    })) as unknown as DesktopAPI;
    Object.defineProperty(window, 'desktop', { value: Object.freeze(desktop) });
}
