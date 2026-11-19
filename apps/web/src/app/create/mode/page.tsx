'use client';

/**
 * Mode select (SCRAM-SPEC §4) — two cards, nothing else.
 *
 * The card tap IS the action: it creates the room (live when a Worker
 * URL is set, demo otherwise) with the picked mode and the host's
 * codename, then navigates to the lobby-is-setup screen. The host's
 * codename is asked here because room creation needs a display name;
 * there is no separate setup form — setup lives in the lobby.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_ROOM_CONFIG,
  isValidDisplayName,
  type MatchMode,
} from '@pakdam/shared';
import { circlePolygon } from '@pakdam/engine';
import { isLiveTransportEnabled } from '../../../lib/websocket';
import { createLiveRoom } from '../../../lib/live-client';
import { createRoom as createDemoRoom } from '../../../lib/demo-store';
import { storeDemoSeat } from '../../../lib/session-credentials';

const MODES: { mode: MatchMode; title: string; line: string }[] = [
  { mode: 'classic', title: 'Classic', line: "Tagged? You're out. Watch live." },
  { mode: 'infection', title: 'Infection', line: 'Tagged? You join the Hunters.' },
];

export default function ModeSelectPage() {
  const router = useRouter();
  const [codename, setCodename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<MatchMode | null>(null);

  const pick = async (mode: MatchMode): Promise<void> => {
    const name = codename.trim();
    if (!isValidDisplayName(name)) {
      setError('Enter a codename between 1 and 30 characters.');
      return;
    }
    setError(null);
    setCreating(mode);
    try {
      // SCRAM-SPEC §13 defaults: 30 min round (the shared default is
      // 60 min — the spec's 30 min wins here), 500 m zone at Ranchi
      // until the lobby's GPS fix re-centres it.
      const config = {
        ...DEFAULT_ROOM_CONFIG,
        mode,
        durationSeconds: 1800,
        hostOnSiteConfirmed: true,
        zone: {
          boundary: circlePolygon({ lat: 23.36, lng: 85.33 }, 500),
          shrinkPhases: [],
        },
      };
      if (isLiveTransportEnabled()) {
        const session = await createLiveRoom(name, config);
        router.push(`/room/${session.roomId}`);
      } else {
        const demo = createDemoRoom(name, config);
        storeDemoSeat({
          mode: 'demo',
          roomId: demo.room.roomId,
          playerId: demo.room.hostPlayerId,
          displayName: name,
          isHost: true,
          roomCode: demo.room.roomCode,
        });
        router.push(`/room/${demo.room.roomId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the room — try again.');
      setCreating(null);
    }
  };

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[560px] px-4 pb-6 pt-6">
      <header className="flex items-center">
        <button
          type="button"
          onClick={() => router.push('/')}
          aria-label="Back"
          className="text-[22px] font-bold text-[#EF4444]"
        >
          ‹
        </button>
        <h1 className="flex-1 text-center text-[18px] font-bold text-white">Pick a mode</h1>
        <span className="w-6" aria-hidden />
      </header>

      <label className="mt-6 block">
        <span className="pakdam-label">Your codename</span>
        <input
          value={codename}
          onChange={(event) => {
            setCodename(event.target.value.slice(0, 30));
            setError(null);
          }}
          placeholder="e.g. Teo"
          autoComplete="off"
          className="mt-2 h-14 w-full rounded-[14px] border border-[#26262B] bg-[#1E1E22] px-4 text-[17px] font-bold text-white placeholder:text-[#A1A1AA]"
        />
      </label>
      {error ? <p className="mt-2 text-[13px] text-[#EF4444]">{error}</p> : null}

      <div className="mt-4 flex flex-col gap-3">
        {MODES.map(({ mode, title, line }) => (
          <button
            key={mode}
            type="button"
            disabled={creating !== null}
            onClick={() => void pick(mode)}
            className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4 text-left disabled:opacity-60"
          >
            <span className="block text-[20px] font-bold text-white">{title}</span>
            <span className="mt-1 block text-[15px] text-[#A1A1AA]">{line}</span>
            {creating === mode ? (
              <span className="mt-2 block text-[13px] text-[#A1A1AA]">Creating room…</span>
            ) : null}
          </button>
        ))}
      </div>
    </main>
  );
}
