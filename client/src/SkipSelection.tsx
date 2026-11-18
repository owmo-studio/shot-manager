import { useEffect, useRef } from "react";

export function SkipSelection({ count, skippedCount, disabled, onChange }: {
    count: number; skippedCount: number; disabled: boolean; onChange: (skipped: boolean) => void;
}) {
    const mixed = skippedCount > 0 && skippedCount < count;
    const locked = disabled || count === 0;
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
    return <label title={`${skippedCount > 0 ? "Stop skipping selected clips" : "Skip selected clips"}${count > 1 ? ` (${skippedCount} of ${count} skipped)` : ""}`}
        className={`group/skip relative inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/8 transition duration-75 has-[:checked]:border-white has-[:checked]:bg-white has-[:checked]:hover:bg-zinc-100 has-[:indeterminate]:border-white has-[:indeterminate]:bg-white has-[:indeterminate]:hover:bg-zinc-100 ${locked ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:border-white/25 hover:bg-white/15"}`}>
        <input ref={input} type="checkbox" aria-label="Skip selected clips" aria-checked={mixed ? "mixed" : count > 0 && skippedCount === count}
            checked={count > 0 && skippedCount === count} disabled={locked}
            onChange={() => onChange(skippedCount === 0)} className="peer absolute inset-0 size-full cursor-[inherit] opacity-0" />
        <span className="pointer-events-none flex items-center gap-1.5 text-zinc-200 peer-checked:text-black peer-indeterminate:text-black peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-blue-400">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-4">
                <circle cx="12" cy="12" r="9" />
                <path d="M8 12h8" />
            </svg>
        </span>
    </label>;
}

