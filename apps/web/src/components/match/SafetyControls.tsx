/**
 * SafetyControls — safety during play (SCRAM-SPEC §8c–d, BEHAVIOUR §2).
 *
 * No safety theatre: every label says what the control actually does.
 *
 * - SOS alerts the host in this game. Pakdam is NOT an emergency service
 *   and does not call police or ambulance. (Exact `SOS_COPY`.) In demo
 *   mode SOS notifies nobody — the demo copy says so plainly.
 * - Safety pause freezes the match clock for everyone; resume returns to
 *   the phase paused from, never hard-codes ACTIVE. Any player may pause.
 * - "I'm safe" travels as an announcement to everyone in the room.
 *
 * SOS is one tap away on the play screen at all times. When an SOS is
 * active, the host sees who raised it; the player who raised it sees that
 * the host has been alerted.
 */
'use client';

import type { MatchPhase } from '@pakdam/shared';
import { SOS_COPY } from '@pakdam/shared';
import { SOS_DEMO_COPY } from '@/lib/demo-store';
import { Button } from '@/components/ui/Button';

export interface SafetyControlsProps {
  phase: MatchPhase;
  paused: boolean;
  pausedByName: string | null;
  /** The phase to return to on resume (demo knows it; live keeps it server-side). */
  pausedFrom: MatchPhase | null;
  sosActive: boolean;
  sosByName: string | null;
  /** True when the viewer is the host (sees who raised an SOS). */
  isHost: boolean;
  /** True when I raised the SOS currently active. */
  sosIsMine: boolean;
  /** Demo mode: SOS notifies nobody. */
  isDemo: boolean;
  canPause: boolean;
  onSos: () => void;
  onPause: () => void;
  onResume: () => void;
  onAnnounceSafe: () => void;
}

export function SafetyControls({
  phase,
  paused,
  pausedByName,
  pausedFrom,
  sosActive,
  sosByName,
  isHost,
  sosIsMine,
  isDemo,
  canPause,
  onSos,
  onPause,
  onResume,
  onAnnounceSafe,
}: SafetyControlsProps) {
  const pausable = canPause && (phase === 'HEAD_START' || phase === 'ACTIVE');

  return (
    <div className="flex flex-col gap-4">
      {/* SOS — always one tap away during play. */}
      <div>
        <Button variant="primary" onClick={onSos} disabled={sosActive && sosIsMine}>
          {sosActive && sosIsMine ? 'SOS sent' : 'SOS'}
        </Button>
        <p className="mt-2 text-[13px] text-[#A1A1AA]">{isDemo ? SOS_DEMO_COPY : SOS_COPY}</p>
        {sosActive && isHost && sosByName ? (
          <p className="mt-2 text-[14px] font-semibold text-[#EF4444]">
            SOS raised by {sosByName} — check on them.
          </p>
        ) : null}
        {sosActive && sosIsMine && !isHost ? (
          <p className="mt-2 text-[14px] font-semibold text-[#EF4444]">
            SOS sent — the host has been alerted.
          </p>
        ) : null}
      </div>

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
            <Button variant="outline" onClick={onResume} className="mt-3">
              Resume the match
            </Button>
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

      {/* Tell everyone — an announcement, not a command. */}
      <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
        <p className="text-[15px] font-bold text-white">Tell everyone</p>
        <p className="mt-1 text-[13px] text-[#A1A1AA]">
          Sends &ldquo;I&rsquo;m safe&rdquo; to everyone in the room.
        </p>
        <Button variant="ghost" onClick={onAnnounceSafe} className="mt-3">
          I&rsquo;m safe
        </Button>
      </div>
    </div>
  );
}
