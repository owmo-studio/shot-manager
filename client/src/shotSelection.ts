import { useEffect, useReducer } from "react";
import type { VideoShot } from "../../shared/shots";

export function orderedShots(shots: VideoShot[], newestFirst: boolean) {
    const direction = newestFirst ? -1 : 1;
    return [...shots].sort((first, second) => direction * (
        first.timestamp.slice(0, 10).localeCompare(second.timestamp.slice(0, 10)) ||
        Date.parse(first.timestamp) - Date.parse(second.timestamp)
    ) || first.id.localeCompare(second.id));
}

interface SelectionState {
    editingIds: string[];
    anchorId: string | null;
    activeId: string | null;
}
type Action =
    | { type: "select"; id: string; orderedIds: string[]; additive: boolean; range: boolean }
    | { type: "navigate"; direction: -1 | 1; orderedIds: string[]; selectableIds: string[]; layout?: { id: string; x: number; y: number }[] }
    | { type: "clear" }
    | { type: "reconcile"; existingIds: string[]; visibleIds: string[] };

function reducer(state: SelectionState, action: Action): SelectionState {
    switch (action.type) {
        case "select": {
            if (!action.orderedIds.includes(action.id)) return state;
            const anchor = state.anchorId ? action.orderedIds.indexOf(state.anchorId) : -1;
            if (action.range && anchor >= 0) {
                const target = action.orderedIds.indexOf(action.id);
                const range = action.orderedIds.slice(Math.min(anchor, target), Math.max(anchor, target) + 1);
                return { ...state, editingIds: action.additive ? [...new Set([...state.editingIds, ...range])] : range, activeId: action.id };
            }
            const editingIds = action.additive
                ? state.editingIds.includes(action.id) ? state.editingIds.filter((id) => id !== action.id) : [...state.editingIds, action.id]
                : [action.id];
            return { ...state, editingIds, anchorId: action.id, activeId: editingIds.includes(action.id) ? action.id : editingIds.at(-1) ?? null };
        }
        case "navigate": {
            if (!state.editingIds.length || !state.activeId) return state;
            const current = action.orderedIds.indexOf(state.activeId);
            if (current < 0) return state;
            const selectable = new Set(action.selectableIds);
            if (action.layout) {
                const origin = action.layout.find((card) => card.id === state.activeId);
                if (!origin) return state;
                // Tolerate subpixel layout and the small card entrance animation.
                const rowTolerance = 8;
                const candidates = action.layout.filter((card) => selectable.has(card.id) && (card.y - origin.y) * action.direction > rowTolerance);
                if (!candidates.length) return state;
                const rowDistance = Math.min(...candidates.map((card) => Math.abs(card.y - origin.y)));
                const target = candidates.filter((card) => Math.abs(Math.abs(card.y - origin.y) - rowDistance) < rowTolerance)
                    .sort((first, second) => Math.abs(first.x - origin.x) - Math.abs(second.x - origin.x) || first.x - second.x)[0];
                return { ...state, editingIds: [target.id], anchorId: target.id, activeId: target.id };
            }
            for (let index = current + action.direction; index >= 0 && index < action.orderedIds.length; index += action.direction) {
                const id = action.orderedIds[index];
                if (selectable.has(id)) return { ...state, editingIds: [id], anchorId: id, activeId: id };
            }
            return state;
        }
        case "clear": return { ...state, editingIds: [], anchorId: null, activeId: null };
        case "reconcile": {
            const existing = new Set(action.existingIds), visible = new Set(action.visibleIds);
            const editingIds = state.editingIds.filter((id) => existing.has(id) && visible.has(id));
            const anchorId = state.anchorId && visible.has(state.anchorId) ? state.anchorId : null;
            const activeId = state.activeId && editingIds.includes(state.activeId) ? state.activeId : editingIds.at(-1) ?? null;
            return editingIds.length === state.editingIds.length && anchorId === state.anchorId && activeId === state.activeId
                ? state : { editingIds, anchorId, activeId };
        }
    }
}

// Editing selection is transient; skip intent comes from the saved clip draft.
export function useShotSelection(shots: VideoShot[], visibleShots: VideoShot[]) {
    const [state, dispatch] = useReducer(reducer, { editingIds: [], anchorId: null, activeId: null });
    const existingKey = JSON.stringify(shots.map((shot) => shot.id));
    const visibleKey = JSON.stringify(visibleShots.map((shot) => shot.id));
    useEffect(() => {
        dispatch({ type: "reconcile", existingIds: JSON.parse(existingKey), visibleIds: JSON.parse(visibleKey) });
    }, [existingKey, visibleKey]);
    return { ...state, dispatch };
}
