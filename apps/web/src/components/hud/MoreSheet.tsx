/**
 * MoreSheet — the play page's "More" tab content (v29 R20).
 *
 * Extracted verbatim from `app/room/[roomId]/play/page.tsx` so the play
 * page does not evaluate this whole subtree on every render: the sheet
 * is rendered only when `tab === 'more'` (the parent gates it), and
 * `memo` skips re-rendering while the sheet is closed unless a prop
 * actually changed. The parent still owns the `<Sheet>` wrapper and
 * the `tab === 'more'` gate; this component is the sheet's *content*.
 *
 * No behaviour change — same buttons, same copy, same props flow.
 */
import { memo } from 'react';
import type { MatchPhase, PlayerView } from '@pakdam/shared';
import { SafetyControls } from '@/components/match/SafetyControls';
import { Toggle } from '@/components/ui/Toggle';
import type { CueSettings } from '@/lib/cues';

export interface PlayerStatus {
  player: PlayerView;
  taggerName: string | null;
}

export interface MoreSheetProps {
  isHost: boolean;
  displayPhase: MatchPhase;
  playerStatuses: PlayerStatus[];
  myPlayerId: string;
  cueSettings: CueSettings;
  setCueSetting: (patch: Partial<CueSettings>) => void;
  effectivePaused: boolean;
  pausedByName: string | null;
  /** The phase the pause came from (demo `pausedFrom`) — a MatchPhase, not a timestamp. */
  pausedFrom: MatchPhase | null;
  canPause: boolean;
  onPause: () => void;
  onResume: () => void;
  onEndRound: () => void;
  onLeave: () => void;
  leaveArmed: boolean;
}

export const MoreSheet = memo(function MoreSheet({
  isHost,
  displayPhase,
  playerStatuses,
  myPlayerId,
  cueSettings,
  setCueSetting,
  effectivePaused,
  pausedByName,
  pausedFrom,
  canPause,
  onPause,
  onResume,
  onEndRound,
  onLeave,
  leaveArmed,
}: MoreSheetProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Host only: end the round early (POST …/lifecycle, host-only).
          Host cancel deletes the room (founder decision, 2026-11-21),
          so every player goes home with the one plain message —
          never to results. A match that ends on its own (time up /
          all caught) still goes to results via the terminal effect. */}
      {isHost &&
      (displayPhase === 'HEAD_START' ||
        displayPhase === 'ACTIVE' ||
        displayPhase === 'SAFETY_PAUSED') ? (
        <button
          type="button"
          onClick={onEndRound}
          className="self-start text-[15px] font-semibold text-[#EF4444]"
        >
          End the round
        </button>
      ) : null}
      {/* Players — the complete roster still in the room, each with
          an Alive / Tagged status. Tagged names its tagger, from the
          same confirmed-catch data as the results page. */}
      <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
        <p className="text-[15px] font-bold text-white">
          Players · {playerStatuses.length}
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {playerStatuses.map(({ player, taggerName }) => (
            <li key={player.playerId} className="flex items-start justify-between gap-3">
              <span className="min-w-0 truncate text-[15px] font-semibold text-white">
                {player.displayName}
                {player.playerId === myPlayerId ? ' (you)' : ''}
              </span>
              {taggerName ? (
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="rounded-full bg-[#EF4444] px-2 py-0.5 text-[12px] font-bold text-white">
                    Tagged
                  </span>
                  <span className="text-[12px] text-[#A1A1AA]">Tagged by {taggerName}</span>
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-[#22C55E] px-2 py-0.5 text-[12px] font-bold text-black">
                  Alive
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {/* Sound & vibration — haptics + cue tones. Separate state
          from the voice-radio mute: this mutes only cue sounds. */}
      <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
        <p className="text-[15px] font-bold text-white">Sound &amp; vibration</p>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold text-white">Vibration (Android only)</p>
            <p className="text-[13px] text-[#A1A1AA]">
              Buzz on pings, zone warnings and tags. Silent on devices without vibration support.
            </p>
          </div>
          <Toggle
            checked={cueSettings.hapticsEnabled}
            onChange={(checked) => setCueSetting({ hapticsEnabled: checked })}
            label="Vibration (Android only)"
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold text-white">Cue sounds</p>
            <p className="text-[13px] text-[#A1A1AA]">
              Short tones for pings, zone warnings and tags. Off by default. This does not mute
              voice radio.
            </p>
          </div>
          <Toggle
            checked={cueSettings.soundsEnabled}
            onChange={(checked) => setCueSetting({ soundsEnabled: checked })}
            label="Cue sounds"
          />
        </div>
      </div>
      <SafetyControls
        phase={displayPhase}
        paused={effectivePaused}
        pausedByName={pausedByName}
        pausedFrom={pausedFrom}
        canPause={canPause}
        isHost={isHost}
        onPause={onPause}
        onResume={onResume}
      />
      <button
        type="button"
        onClick={onLeave}
        className="self-start text-[15px] font-semibold text-[#EF4444]"
      >
        {leaveArmed ? 'Tap again to leave' : 'Leave game'}
      </button>
    </div>
  );
});
