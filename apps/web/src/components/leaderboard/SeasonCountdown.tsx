'use client';
import { useEffect, useState } from 'react';

/**
 * Live countdown to the end of the current monthly season.
 *
 * A season is one calendar month. It ends at 23:59 on the last day of
 * the month, local time. The countdown ticks every 30 seconds — often
 * enough to feel live, seldom enough to stay quiet for screen readers
 * (no aria-live: the text is there to read, not to announce).
 *
 * Pure helpers are exported so the maths can be checked without a
 * browser: `seasonEndMs` and `countdownParts`.
 */

/** End of the current month (23:59:59 local), in ms since epoch. */
export function seasonEndMs(now: Date): number {
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return end.getTime();
}

/** Whole days / hours / minutes left until `targetMs`, or null when it passed. */
export function countdownParts(
  targetMs: number,
  nowMs: number,
): { days: number; hours: number; minutes: number } | null {
  const left = targetMs - nowMs;
  if (left <= 0) return null;
  const minutes = Math.floor(left / 60000);
  return {
    days: Math.floor(minutes / 1440),
    hours: Math.floor((minutes % 1440) / 60),
    minutes: minutes % 60,
  };
}

export function formatCountdown(parts: { days: number; hours: number; minutes: number }): string {
  if (parts.days > 0) return `${parts.days} day${parts.days === 1 ? '' : 's'} ${parts.hours} hr ${parts.minutes} min`;
  if (parts.hours > 0) return `${parts.hours} hr ${parts.minutes} min`;
  return `${parts.minutes} min`;
}

export default function SeasonCountdown({ seasonLabel }: { seasonLabel: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const end = seasonEndMs(new Date(nowMs));
  const parts = countdownParts(end, nowMs);
  const endLabel = new Date(end).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <p className="small" style={{ margin: '4px 0 0' }}>
      <strong>
        {parts
          ? `Season ends in ${formatCountdown(parts)}`
          : 'Season ending — the new season starts tomorrow'}
      </strong>{' '}
      · {seasonLabel} season closes {endLabel}, 11:59 pm. Points reset with the new month — last season&apos;s
      board is kept on this device only.
    </p>
  );
}
