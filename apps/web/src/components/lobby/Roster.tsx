'use client';

/**
 * Roster — the Players card rows (SCRAM-SPEC §7.2).
 *
 * Join order, host first. Rounded-square initials avatar with a gold star
 * on the host; HOST pill (host row only), READY pill (ready players only).
 * Suspended rows show `✕ Suspended` + a freshness label. Roles are NOT
 * shown in the lobby — roles are decided at start. Below the rows the
 * card is empty dark space (ShadowHunt form — the emptiness is the
 * design, so this component renders no empty-state copy).
 */
import { memo, useState } from 'react';
import type { PlayerView } from '@pakdam/shared';
import { Pill } from '../ui/Pill';
import { initialsForName } from '../../lib/utils';
import { locationFreshnessLabel } from '../../lib/geolocation';
import { submitReport } from '../../lib/live-client';
import { isLiveTransportEnabled } from '../../lib/websocket';

export interface RosterProps {
  players: PlayerView[];
  hostPlayerId: string;
  myPlayerId: string | null;
  isHost: boolean;
  /** When the host picks Hunters by hand (Random OFF). */
  pickingHunters: boolean;
  selectedHunterIds: string[];
  hunterCount: number;
  onToggleHunter?: (playerId: string) => void;
  onRemove?: (playerId: string) => void;
}

function freshnessLabel(player: PlayerView): string {
  if (!player.lastFixAt) return locationFreshnessLabel(null);
  return locationFreshnessLabel(new Date(player.lastFixAt).getTime());
}

/** Memoized (B14): the lobby re-renders on every poll tick — the roster only re-renders when its players or handlers change. */
export const Roster = memo(function Roster({
  players,
  hostPlayerId,
  myPlayerId,
  isHost,
  pickingHunters,
  selectedHunterIds,
  hunterCount,
  onToggleHunter,
  onRemove,
}: RosterProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const active = players.filter((p) => p.leftAt === null);

  // Report / Block (POST /v1/reports): audit record ONLY — a block does
  // NOT remove or silence anyone. Live only; demo has no Worker to
  // receive the report.
  const handleReport = (target: PlayerView, kind: 'report' | 'block'): void => {
    setMenuFor(null);
    if (!isLiveTransportEnabled()) {
      setActionNote('Reports need the live server — not available in a demo game.');
      return;
    }
    void submitReport(target.roomId, target.playerId, kind)
      .then(() => {
        setActionNote(
          kind === 'report'
            ? `${target.displayName} reported — the host reviews it later.`
            : `${target.displayName} blocked — recorded for the host. Blocking does not remove or silence them.`,
        );
      })
      .catch(() => {
        setActionNote('Could not send that — check your connection and try again.');
      });
  };
  const sorted = [...active].sort((a, b) => {
    if (a.playerId === hostPlayerId) return -1;
    if (b.playerId === hostPlayerId) return 1;
    return a.joinedAt.localeCompare(b.joinedAt);
  });
  return (
    <ul className="divide-y divide-[#26262B]">
      {sorted.map((player) => {
        const isPlayerHost = player.playerId === hostPlayerId;
        const suspended = player.connectionState === 'suspended';
        const ejected = player.ejectedAt !== null;
        const selected = selectedHunterIds.includes(player.playerId);
        const pickable = pickingHunters && isHost && !ejected;
        return (
          <li key={player.playerId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            {pickable ? (
              <button
                type="button"
                aria-label={`Pick ${player.displayName} as Hunter`}
                aria-pressed={selected}
                onClick={() => onToggleHunter?.(player.playerId)}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border text-[13px] font-bold ${
                  selected
                    ? 'border-[#EF4444] bg-[#EF4444] text-white'
                    : 'border-[#26262B] bg-[#1E1E22] text-transparent'
                }`}
              >
                ✓
              </button>
            ) : null}
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-[#1E1E22] text-[15px] font-bold text-white">
              {initialsForName(player.displayName)}
              {isPlayerHost ? (
                <span
                  aria-label="Host"
                  className="absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#F59E0B] text-[10px] text-black"
                >
                  ★
                </span>
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold text-white">
                {player.displayName}
                {player.playerId === myPlayerId ? ' (you)' : ''}
              </span>
              {suspended ? (
                <span className="block text-[13px] text-[#A1A1AA]">
                  ✕ Suspended · {freshnessLabel(player)}
                </span>
              ) : ejected ? (
                <span className="block text-[13px] text-[#A1A1AA]">Ejected</span>
              ) : player.lastFixAt ? (
                <span className="block text-[13px] text-[#A1A1AA]">
                  {freshnessLabel(player)}
                </span>
              ) : null}
            </span>
            {isPlayerHost ? <Pill tone="host">HOST</Pill> : null}
            {player.isReady ? <Pill tone="ready">READY</Pill> : null}
            {pickingHunters && selected ? <Pill tone="hunter">Hunter</Pill> : null}
            {isHost && !isPlayerHost ? (
              <span className="relative shrink-0">
                <button
                  type="button"
                  aria-label={`Options for ${player.displayName}`}
                  aria-expanded={menuFor === player.playerId}
                  onClick={() => setMenuFor((m) => (m === player.playerId ? null : player.playerId))}
                  className="px-2 text-[18px] font-bold text-[#A1A1AA]"
                >
                  ···
                </button>
                {menuFor === player.playerId ? (
                  <span className="absolute right-0 top-9 z-10 flex flex-col rounded-[10px] border border-[#26262B] bg-[#1E1E22] py-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => handleReport(player, 'report')}
                      className="px-4 py-2 text-left text-[15px] font-semibold text-white"
                    >
                      Report
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReport(player, 'block')}
                      className="px-4 py-2 text-left text-[15px] font-semibold text-white"
                    >
                      Block
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuFor(null);
                        onRemove?.(player.playerId);
                      }}
                      className="px-4 py-2 text-left text-[15px] font-semibold text-[#EF4444]"
                    >
                      Remove
                    </button>
                  </span>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
      {pickingHunters && isHost ? (
        <li className="pt-3 text-[13px] text-[#A1A1AA]">
          {selectedHunterIds.length} of {hunterCount} Hunters picked — tap a player to pick them.
        </li>
      ) : null}
      {actionNote ? (
        <li className="pt-3 text-[13px] text-[#A1A1AA]" role="status">
          {actionNote}
        </li>
      ) : null}
    </ul>
  );
});
