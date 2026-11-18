// Shared structure and sizing; appearance variants never override button geometry.
const base = 'inline-flex items-center justify-center rounded-md border transition focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40';
const regular = `${base} px-3 py-1.5 text-xs font-medium focus-visible:outline-offset-2`;
const compact = `${base} size-7 shrink-0 duration-75`;

const secondary = 'border-white/15 bg-white/5 text-zinc-200 enabled:hover:bg-white/10 focus-visible:outline-zinc-400';
const primary = 'border-blue-500 bg-blue-500 text-white enabled:hover:border-blue-400 enabled:hover:bg-blue-400 focus-visible:outline-blue-400';
const critical = 'border-red-600 bg-red-600 text-white enabled:hover:border-red-500 enabled:hover:bg-red-500 focus-visible:outline-red-400';
const criticalSubtle = 'border-red-500/30 bg-red-500/10 text-red-300 enabled:hover:bg-red-500/20 enabled:hover:text-red-200 focus-visible:outline-red-400';

export const secondaryButton = `${regular} ${secondary}`;
export const smallSecondaryButton = `${base} px-2 py-1 text-[10px] font-medium focus-visible:outline-offset-2 ${secondary}`;
export const primaryButton = `${regular} ${primary}`;
export const dangerButton = `${regular} ${critical}`;
export const dangerSecondaryButton = `${regular} ${criticalSubtle}`;

const inspectorSurface = 'border-white/15 bg-white/8';
const inspector = `${inspectorSurface} text-zinc-200`;
export const inspectorButton = `${compact} ${inspector} enabled:hover:border-white/25 enabled:hover:bg-white/15 enabled:hover:text-white focus-visible:outline-blue-400`;
export const inspectorDangerButton = `${compact} ${inspector} enabled:hover:border-[#d62828]/70 enabled:hover:bg-[#c02020]/40 enabled:hover:text-white enabled:active:border-[#e02a2a]/90 enabled:active:bg-[#d02020]/60 enabled:active:text-white focus-visible:outline-red-400`;

export const inspectorChangedButton = `${compact} ${inspectorSurface} text-amber-200 ring-1 ring-amber-400/60 enabled:hover:border-white/25 enabled:hover:bg-white/15 enabled:hover:text-white focus-visible:outline-blue-400`;
export const smallDangerButton = `${base} h-7 px-2 text-[10px] font-medium duration-75 ${inspector} enabled:hover:border-red-400/40 enabled:hover:bg-red-500/15 enabled:hover:text-red-200 focus-visible:outline-blue-400`;
