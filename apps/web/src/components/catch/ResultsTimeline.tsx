/**
 * ResultsTimeline — "What happened" (SCRAM-SPEC §10).
 *
 * One line per event, mm:ss only, newest last, max 6. The caller builds
 * the events from what the match actually recorded — live results have no
 * per-tag times (the snapshot never carries them), so a live timeline is
 * short rather than invented.
 */
'use client';

import { formatAgeLabel } from '@pakdam/shared';

export interface TimelineEvent {
  /** Seconds from match start. */
  atSeconds: number;
  text: string;
}

export interface ResultsTimelineProps {
  events: TimelineEvent[];
}

export function ResultsTimeline({ events }: ResultsTimelineProps) {
  const sorted = [...events].sort((a, b) => a.atSeconds - b.atSeconds);
  // Max 6: keep the start, then the newest five.
  const shown =
    sorted.length > 6 ? [sorted[0], ...sorted.slice(-5)] : sorted;
  const shownEvents = shown.filter(
    (event): event is TimelineEvent => event !== undefined,
  );

  if (shownEvents.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {shownEvents.map((event, i) => (
        <div
          key={`${event.atSeconds}-${i}`}
          className="border-l-2 border-[#EF4444] pl-3"
        >
          <p className="text-[15px] text-white">
            <span className="pakdam-numeric font-bold">
              {formatAgeLabel(event.atSeconds)}
            </span>{' '}
            {event.text}
          </p>
        </div>
      ))}
    </div>
  );
}
