/**
 * PlayerDots — the dots on the play map (SCRAM-SPEC §8c).
 *
 * Honest by construction: snapshots carry no coordinates, so no dot here
 * is ever placed at an invented position. Each dot is a chip:
 *
 * - own team, live: a green dot with the name and the last-fix freshness
 *   (`Last fix 0:20 ago`, `Location unknown`, `Suspended`).
 * - other team, ping-only: a dot with the name and the ping age
 *   (`TEO · 0:20 ago`). Pings stay until the next ping replaces them.
 *   Ping dots are coloured by the SUBJECT's team: green for a Runner
 *   subject, red for a Hunter subject.
 * - me: a red dot labelled `YOU`.
 *
 * The play page decides which dots a role may see: each side receives
 * only the opposing team's ping dots, never the other team's live
 * position — only pings. A spectator sees both teams' ping dots and no
 * live dots at all. This component only renders what it is given.
 */
'use client';

export interface PlayerDot {
  playerId: string;
  displayName: string;
  /**
   * 'me' | 'teammate' (own team, live) | 'ping-runner' (other team,
   * ping-only, subject is a Runner) | 'ping-hunter' (other team,
   * ping-only, subject is a Hunter).
   */
  tone: 'me' | 'teammate' | 'ping-runner' | 'ping-hunter';
  /** Age / freshness label, e.g. `0:20 ago` or `Last fix 0:20 ago`. */
  label: string;
  suspended?: boolean;
}

export interface PlayerDotsProps {
  dots: PlayerDot[];
}

function dotColor(tone: PlayerDot['tone'], suspended?: boolean): string {
  if (suspended) return 'bg-[#A1A1AA]';
  if (tone === 'me') return 'bg-[#EF4444]';
  if (tone === 'teammate') return 'bg-[#22C55E]';
  if (tone === 'ping-runner') return 'bg-[#22C55E]';
  return 'bg-[#EF4444]';
}

export function PlayerDots({ dots }: PlayerDotsProps) {
  if (dots.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-6rem)] flex-wrap gap-1.5">
      {dots.map((dot) => (
        <span
          key={dot.playerId}
          className="flex items-center gap-1.5 rounded-full border border-[#26262B] bg-black/70 px-2 py-1 text-[12px] font-semibold text-white backdrop-blur-sm"
        >
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dotColor(dot.tone, dot.suspended)}`}
          />
          <span className="uppercase">{dot.displayName}</span>
          <span className="pakdam-numeric font-normal text-[#A1A1AA]">
            {dot.suspended ? 'Suspended' : dot.label}
          </span>
        </span>
      ))}
    </div>
  );
}
