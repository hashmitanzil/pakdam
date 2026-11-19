import type { ReactNode } from 'react';

/**
 * Pill / Badge — SCRAM-SPEC §11.
 * HOST: red outline/red text. READY: green outline/green text.
 * Hunter: red fill/white text. Runner: white fill/black text.
 * Random: dark fill/grey text. Badge: red dot with white number.
 */
export type PillTone =
  | 'host'
  | 'ready'
  | 'hunter'
  | 'runner'
  | 'random'
  | 'neutral'
  | 'warning';

const tones: Record<PillTone, string> = {
  host: 'border border-[#EF4444] text-[#EF4444]',
  ready: 'border border-[#22C55E] text-[#22C55E]',
  hunter: 'bg-[#EF4444] text-white border border-transparent',
  runner: 'bg-white text-black border border-transparent',
  random: 'bg-[#1E1E22] text-[#A1A1AA] border border-transparent',
  neutral: 'border border-[#26262B] text-[#A1A1AA]',
  warning: 'border border-[#F59E0B] text-[#F59E0B]',
};

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
}

export function Pill({ tone = 'neutral', children }: PillProps) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-full px-2 text-[11px] font-bold uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Badge: red dot with a white number (e.g. unread radio count). */
export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#EF4444] px-1 text-[11px] font-bold text-white pakdam-numeric">
      {count > 99 ? '99+' : count}
    </span>
  );
}
