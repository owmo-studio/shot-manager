export type MediaReadinessState = 'unchecked' | 'preparing' | 'ready' | 'committed' | 'unavailable';
export interface MediaReadiness { state: MediaReadinessState; detail?: string }

export function mediaReadiness(facts: {
    checked: boolean; committed: boolean; source: boolean; thumbnail: boolean; metadata: boolean; proxy: boolean; error?: string;
}): MediaReadiness {
    if (facts.error) return { state: 'unavailable', detail: facts.error };
    if (facts.checked && facts.committed) return { state: 'committed' };
    if (!facts.checked) return { state: 'unchecked' };
    return { state: facts.source && facts.thumbnail && facts.metadata && facts.proxy ? 'ready' : 'preparing' };
}
