import type { ImportSource } from "../../shared/desktop";

export function newlyUnavailableSources(sources: ImportSource[], notified: Set<string>): ImportSource[] {
    const unavailableIds = new Set(sources.filter((source) => !source.available).map((source) => source.id));
    for (const id of notified) {
        if (!unavailableIds.has(id)) notified.delete(id);
    }
    const newlyUnavailable = sources.filter((source) => !source.available && !notified.has(source.id));
    for (const source of newlyUnavailable) notified.add(source.id);
    return newlyUnavailable;
}
