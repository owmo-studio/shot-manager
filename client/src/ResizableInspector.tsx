import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export const MIN_INSPECTOR_WIDTH = 560;

export function ResizableInspector({ width, onResize, children }: {
    width: number;
    onResize: (width: number) => void;
    children: ReactNode;
}) {
    const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
    const [resizing, setResizing] = useState(false);
    const drag = useRef<{ startX: number; startWidth: number } | null>(null);
    const maximumWidth = Math.max(MIN_INSPECTOR_WIDTH, viewportWidth - 528);
    const visibleWidth = Math.round(Math.max(MIN_INSPECTOR_WIDTH, Math.min(width, maximumWidth)));

    function resize(next: number) {
        onResize(Math.round(Math.max(MIN_INSPECTOR_WIDTH, Math.min(next, maximumWidth))));
    }

    function stopResizing() {
        drag.current = null;
        setResizing(false);
    }

    useEffect(() => {
        const windowResized = () => setViewportWidth(window.innerWidth);
        const windowBlurred = () => stopResizing();
        window.addEventListener("resize", windowResized);
        window.addEventListener("blur", windowBlurred);
        return () => {
            window.removeEventListener("resize", windowResized);
            window.removeEventListener("blur", windowBlurred);
        };
    }, []);

    useEffect(() => {
        if (!resizing) return;
        const previousCursor = document.body.style.cursor;
        document.body.style.cursor = "col-resize";
        return () => { document.body.style.cursor = previousCursor; };
    }, [resizing]);

    return (
        <aside id="clip-inspector" aria-label="Clip inspector" style={{ width: visibleWidth }} className="relative flex min-h-0 min-w-[560px] shrink-0 flex-col border-l border-white/8 bg-white/[0.015]">
            <div
                role="separator"
                aria-label="Resize clip inspector"
                aria-controls="clip-inspector-content"
                aria-orientation="vertical"
                aria-valuemin={MIN_INSPECTOR_WIDTH}
                aria-valuemax={maximumWidth}
                aria-valuenow={visibleWidth}
                aria-valuetext={`${visibleWidth} pixels wide`}
                tabIndex={0}
                title="Drag to resize · Arrow keys to adjust · Double-click to reset"
                className={`absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none transition-colors hover:bg-blue-400/40 focus-visible:bg-blue-400/40 focus-visible:outline-none ${resizing ? "bg-blue-400/40" : ""}`}
                onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { startX: event.clientX, startWidth: visibleWidth };
                    setResizing(true);
                }}
                onPointerMove={(event) => {
                    if (drag.current) resize(drag.current.startWidth + drag.current.startX - event.clientX);
                }}
                onPointerUp={(event) => {
                    stopResizing();
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={stopResizing}
                onLostPointerCapture={stopResizing}
                onDoubleClick={() => onResize(MIN_INSPECTOR_WIDTH)}
                onKeyDown={(event) => {
                    const step = event.shiftKey ? 50 : 10;
                    if (event.key === "ArrowLeft") resize(visibleWidth + step);
                    else if (event.key === "ArrowRight") resize(visibleWidth - step);
                    else if (event.key === "Home") resize(MIN_INSPECTOR_WIDTH);
                    else if (event.key === "End") resize(maximumWidth);
                    else return;
                    event.preventDefault();
                }}
            />
            <div id="clip-inspector-content" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable]">{children}</div>
        </aside>
    );
}
