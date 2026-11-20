/**
 * SafetyControls — safety pause during play (SCRAM-SPEC §8c–d, BEHAVIOUR §2).
 *
 * Pause / resume only. SOS and "I'm safe" were removed (founder decision):
 * there is no SOS trigger in the app and no "Tell everyone" control.
 *
 * - Safety pause freezes the match clock for everyone; resume returns to
 *   the phase paused from, never hard-codes ACTIVE. Any player may pause.
 */
'use client';

import { memo } from 'react';
import type { MatchPhase } from '@pakdam/shared';
import { Button } from '@/components/ui/Button';

export interface SafetyControlsProps {
  phase: MatchPhase;
  paused: boolean;
  pausedByName: string | null;
  /** The phase to return to on resume (demo knows it; live keeps it server-side). */
  pausedFrom: MatchPhase | null;
  canPause: boolean;
  /** Resume is host-only on the server — a non-host never sees the button. */
  isHost: boolean;
  onPause: () => void;
  onResume: () => void;
}

/** Memoized: lives inside the More sheet, re-rendered by the parent's
 *  1 s clock tick — it only needs to update when pause state changes. */
export const SafetyControls = memo(function SafetyControls({
  phase,
  paused,
  pausedByName,
  pausedFrom,
  canPause,
  isHost,
  onPause,
  onResume,
}: SafetyControlsProps) {
  const pausable = canPause && (phase === 'HEAD_START' || phase === 'ACTIVE');

  return (
    <div className="flex flex-col gap-4">
      {/* Safety pause — freezes the clock; resume returns to the phase paused from. */}
      <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
        {paused ? (
          <>
            <p className="text-[15px] font-bold text-white">
              Match paused{pausedByName ? ` by ${pausedByName}` : ''} — clock frozen.
            </p>
            {pausedFrom ? (
              <p className="mt-1 text-[13px] text-[#A1A1AA]">
                Resume returns to {pausedFrom === 'HEAD_START' ? 'the head start' : 'live play'}.
              </p>
            ) : null}
            {isHost ? (
              <Button variant="outline" onClick={onResume} className="mt-3">
                Resume the match
              </Button>
            ) : (
              <p className="mt-2 text-[13px] text-[#A1A1AA]">
                Only the host can resume the match.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[15px] font-bold text-white">Safety pause</p>
            <p className="mt-1 text-[13px] text-[#A1A1AA]">
              Pauses the match for everyone and freezes the clock.
            </p>
            <Button
              variant="outline"
              onClick={onPause}
              disabled={!pausable}
              className="mt-3"
            >
              Pause the match
            </Button>
            {!pausable ? (
              <p className="mt-2 text-[13px] text-[#A1A1AA]">
                The match can&apos;t be paused right now.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
});
