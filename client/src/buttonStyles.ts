// Shared action hierarchy for dialogs and full-size buttons. Compact icon controls stay neutral.
const base = "inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
export const secondaryButton = `${base} border-white/15 bg-white/5 text-zinc-200 enabled:hover:bg-white/10 focus-visible:outline-zinc-400`;
export const primaryButton = `${base} border-blue-500 bg-blue-500 text-white enabled:hover:border-blue-400 enabled:hover:bg-blue-400 focus-visible:outline-blue-400`;
export const dangerButton = `${base} border-red-600 bg-red-600 text-white enabled:hover:border-red-500 enabled:hover:bg-red-500 focus-visible:outline-red-400`;

const inspectorBase = 'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/8 px-2 text-[10px] font-medium text-zinc-200 transition duration-75 focus-visible:outline-2 disabled:opacity-40';
export const inspectorButton = `${inspectorBase} hover:border-white/25 hover:bg-white/15 hover:text-white focus-visible:outline-blue-400`;
export const inspectorDangerButton = `${inspectorBase} enabled:hover:border-[#d62828]/70 enabled:hover:bg-[#c02020]/40 enabled:hover:text-white enabled:active:border-[#e02a2a]/90 enabled:active:bg-[#d02020]/60 enabled:active:text-white focus-visible:outline-red-400`;
