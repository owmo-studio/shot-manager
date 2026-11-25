import type { ReactNode } from 'react';

export function ClipReviewRow({ filename, included, busy, onToggle, mode, children }: {
    filename: string;
    included: boolean;
    busy: boolean;
    onToggle: () => void;
    mode?: string;
    children: ReactNode;
}) {
    return <div data-review-included={included} data-review-mode={mode}
        className={`flex items-start gap-3 border-b border-white/8 p-3 last:border-0 ${included ? '' : 'bg-white/[0.02]'}`}>
        <div className={`flex min-w-0 flex-1 items-start gap-3 ${included ? '' : 'opacity-40'}`}>
            {children}
        </div>
        <button type="button" disabled={busy} onClick={onToggle}
            aria-label={`${included ? 'Remove' : 'Restore'} ${filename} ${included ? 'from' : 'to'} review`}
            aria-pressed={!included}
            className="grid size-7 shrink-0 place-items-center rounded text-2xl leading-none text-zinc-400 hover:bg-white/8 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40">
            {included ? '×' : '−'}
        </button>
    </div>;
}
