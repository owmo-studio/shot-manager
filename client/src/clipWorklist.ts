import { useCallback, useReducer } from 'react';
import type { ShotCollection, VideoShot } from '../../shared/shots';
import { clipQueryDataChanged, emptyClipFilters, matchesClipFilters } from './clipFilters';
import type { ClipFilters } from './clipFilters';

interface QueryShot {
    shot: VideoShot;
    matches: boolean;
}

interface Worklist<T extends ShotCollection> {
    collection: T;
    filters: ClipFilters;
    queryShots: Map<string, QueryShot>;
}

type Action<T> = { type: 'receive'; collection: T } | { type: 'query'; filters?: ClipFilters };

function queryShot(shot: VideoShot, filters: ClipFilters): QueryShot {
    return { shot, matches: matchesClipFilters(shot, filters) };
}

function indexShots(shots: VideoShot[], filters: ClipFilters) {
    return new Map(shots.map(shot => [shot.id, queryShot(shot, filters)]));
}

function worklistReducer<T extends ShotCollection>(state: Worklist<T>, action: Action<T>): Worklist<T> {
    if (action.type === 'query') {
        const filters = action.filters ?? state.filters;
        return { ...state, filters, queryShots: indexShots(state.collection.shots, filters) };
    }

    const { collection } = action;
    const path = (value: T) => 'libraryPath' in value ? value.libraryPath : undefined;
    const previous = path(state.collection) === path(collection) ? state.queryShots : undefined;
    const queryShots = new Map<string, QueryShot>();
    for (const shot of collection.shots) {
        const saved = previous?.get(shot.id);
        // A new row or a successful Library Commit gets a fresh query snapshot.
        queryShots.set(shot.id, saved && saved.shot.libraryCommitRevision === shot.libraryCommitRevision
            ? saved : queryShot(shot, state.filters));
    }
    return { ...state, collection, queryShots };
}

export function useClipWorklist<T extends ShotCollection>(initial: T) {
    const [state, dispatch] = useReducer(worklistReducer<T>, initial, collection => {
        const filters = emptyClipFilters();
        return { collection, filters, queryShots: indexShots(collection.shots, filters) };
    });
    const receive = useCallback((collection: T) => dispatch({ type: 'receive', collection }), []);
    const query = useCallback((filters?: ClipFilters) => dispatch({ type: 'query', filters }), []);
    const { collection, filters, queryShots } = state;
    return {
        collection, filters, receive, query,
        canReapply: collection.shots.some(shot => {
            const previous = queryShots.get(shot.id);
            return previous && clipQueryDataChanged(previous.shot, shot);
        }),
        facetShots: [...queryShots.values()].map(row => row.shot),
        visible: { ...collection, shots: collection.shots.filter(shot => queryShots.get(shot.id)?.matches) },
    };
}
