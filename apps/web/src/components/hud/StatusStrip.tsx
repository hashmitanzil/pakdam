/**
 * StatusStrip — the one status strip on the live HUD (SCRAM-SPEC §8b).
 *
 * One dark card, two rows: time left / next ping, then zone shrink /
 * runners left with a thin progress bar. The next-zone size and location
 * stay hidden until the shrink preview — this strip never shows them.
 * During head start, hunters see the waiting line instead of a timer.
 */
'use client';

import type { MatchPhase, RoomConfig } from '@pakdam/shared';
import { formatCountdown, formatDistance } from '@/lib/utils';
import { formatTimeLeft } from '@/components/match/freshness';

export interface StatusStripProps {
  phase: MatchPhase;
  config: RoomConfig;
  startedAt: string | null;
  endsAt: string | null;
  /** When paused, the clock is frozen at the pause — show the frozen remainder. */
  paused: boolean;
  pausedAt: string | null;
  runnersLeft: number;
  runnersTotal: number;
  /** Epoch ms of the next scheduled ping, or null when pings are off / unknown. */
  nextPingAtMs: number | null;
  /** Epoch ms of the next scheduled shrink, or null when shrinking is off / none left. */
  nextShrinkAtMs: number | null;
  /** Current zone radius in metres (half the zone diameter), or null when unknown. */
  zoneRadiusM: number | null;
  nowMs: number;
  /** My role is Runner — show the hidden line instead of the hunter waiting line. */
  isRunner: boolean;
}

export function StatusStrip({
  phase,
  config,
  startedAt,
  endsAt,
  paused,
  pausedAt,
  runnersLeft,
  runnersTotal,
  nextPingAtMs,
  nextShrinkAtMs,
  zoneRadiusM,
  nowMs,
  isRunner,
}: StatusStripProps) {
  const headStart =
    phase === 'HEAD_START' && startedAt
      ? Math.max(0, new Date(startedAt).getTime() + config.headStartSeconds * 1000 - nowMs)
      : null;

  const timeLeftMs =
    endsAt === null
      ? null
      : paused && pausedAt
        ? Math.max(0, new Date(endsAt).getTime() - new Date(pausedAt).getTime())
        : Math.max(0, new Date(endsAt).getTime() - nowMs);

  const pingsOff = config.pingIntervalSeconds <= 0 || !config.playZoneEnabled;
  const nextPingSeconds =
    nextPingAtMs === null ? null : Math.max(0, Math.ceil((nextPingAtMs - nowMs) / 1000));

  const zoneLabel =
    zoneRadiusM === null ? 'Zone' : `Zone ${formatDistance(zoneRadiusM)}`;
  const shrinkLabel = !config.zoneShrinkEnabled
    ? `${zoneLabel} · no shrink`
    : nextShrinkAtMs === null
      ? `${zoneLabel} · no shrink left`
      : `${zoneLabel} shrinks in ${formatCountdown(Math.ceil((nextShrinkAtMs - nowMs) / 1000))}`;

  const runnersFraction =
    runnersTotal > 0 ? Math.max(0, Math.min(1, runnersLeft / runnersTotal)) : 0;

  return (
    <div className="rounded-2xl border border-[#26262B] bg-[#141416] px-4 py-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="pakdam-label">{paused ? 'Paused' : headStart !== null ? 'Head start' : 'Time left'}</p>
          <p className="pakdam-numeric text-[32px] font-bold leading-none text-white">
            {headStart !== null
              ? formatTimeLeft(headStart)
              : timeLeftMs === null
                ? '--:--'
                : formatTimeLeft(timeLeftMs)}
          </p>
        </div>
        <div className="text-right">
          <p className="pakdam-label">Next ping</p>
          <p className="pakdam-numeric text-[20px] font-bold leading-tight text-white">
            {pingsOff ? 'Pings Off' : nextPingSeconds === null ? '--:--' : formatCountdown(nextPingSeconds)}
          </p>
        </div>
      </div>

      {headStart !== null && !isRunner ? (
        <p className="mt-2 text-[13px] text-[#A1A1AA]">Hunters wait — runners are scattering.</p>
      ) : null}
      {isRunner && (phase === 'HEAD_START' || phase === 'ACTIVE') ? (
        <p className="mt-2 text-[13px] font-semibold text-[#22C55E]">
          HIDDEN FROM HUNTERS — Hunters never shown
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-3 text-[13px]">
        <p className="text-[#A1A1AA]">{shrinkLabel}</p>
        <p className="pakdam-numeric whitespace-nowrap font-semibold text-white">
          Runners left {runnersLeft} of {runnersTotal}
        </p>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#1E1E22]"
        role="progressbar"
        aria-valuenow={runnersLeft}
        aria-valuemin={0}
        aria-valuemax={runnersTotal}
        aria-label="Runners left"
      >
        <div
          className="h-full rounded-full bg-[#EF4444] transition-[width] duration-500"
          style={{ width: `${Math.round(runnersFraction * 100)}%` }}
        />
      </div>
    </div>
  );
}
