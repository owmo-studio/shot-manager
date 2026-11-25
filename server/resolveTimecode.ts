import { inspectProxySource } from './proxyMedia';
import { rational } from './videoMetadata';

// Resolve's Media Pool CSV uses the boundary after the final frame for End TC.
export function resolveTimecodeFields(start: string, rate: number, frames: number): Record<string, string> {
    const parts = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2,3})$/.exec(start);
    const fps = Math.round(rate);
    if (!parts || !Number.isFinite(rate) || fps < 1 || fps > 120 || !Number.isSafeInteger(frames) || frames < 1 ||
        (rate !== fps && Math.abs(rate - fps * 1000 / 1001) > 1e-6)) return {};
    const [h, m, s, f] = [parts[1], parts[2], parts[3], parts[5]].map(Number);
    const drop = parts[4] === ';';
    if (h > 23 || m > 59 || s > 59 || f >= fps || (drop && (rate === fps || (fps !== 30 && fps !== 60)))) return {};
    const skipped = drop ? fps / 15 : 0;
    if (m % 10 && !s && f < skipped) return {};

    const minutes = h * 60 + m;
    const startFrame = ((minutes * 60 + s) * fps + f) - skipped * (minutes - Math.floor(minutes / 10));
    const tenMinutes = 600 * fps - 9 * skipped;
    const endFrame = (startFrame + frames) % (144 * tenMinutes);
    // The first minute in each ten-minute cycle retains all its frame labels.
    const withinCycle = endFrame % tenMinutes;
    const shortenedMinutes = Math.max(0, Math.floor((withinCycle - skipped) / (60 * fps - skipped)));
    const label = endFrame + skipped * (9 * Math.floor(endFrame / tenMinutes) + shortenedMinutes);
    const seconds = Math.floor(label / fps);
    const pad = (n: number) => String(n).padStart(2, '0');
    const end = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(pad).join(':')
        + parts[4] + pad(label % fps);
    return { 'Start TC': start, 'End TC': end };
}

export async function readResolveTimecode(path: string, signal: AbortSignal): Promise<Record<string, string>> {
    // Older Libraries lack stored timing. Read the exported clip's original and reuse the encoder's Sony LTC interpretation.
    let source;
    try { source = await inspectProxySource(path, signal); }
    catch { signal.throwIfAborted(); return {}; }
    const rate = rational(source.constantRate ?? source.reportedRate ?? source.videoRate);
    if (!rate || !source.frameCount) return {};
    if (source.variable) {
        // Keep a VFR range only when its sample count and duration agree on the playback frame grid.
        if (!source.durationSeconds || Math.round(source.durationSeconds * rate) !== source.frameCount) return {};
    }
    return resolveTimecodeFields(source.timecode ?? '00:00:00:00', rate, source.frameCount);
}
