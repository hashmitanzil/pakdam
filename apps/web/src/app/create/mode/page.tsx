'use client';

/**
 * Mode select (SCRAM-SPEC §4) — two cards, nothing else.
 *
 * The card tap IS the action: it creates the room (live when a Worker
 * URL is set, demo otherwise) with the picked mode and the host's
 * codename, then navigates to the create screen (/room/[roomId]/setup)
 * where the host configures the game. The lobby screen (/room/[roomId])
 * comes only after the host taps CREATE LOBBY — the code appears there,
 * never here or on the create screen.
 */
import { useEffect, useState } from 'react';
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
import { prefetchMapAssets } from '../../../components/map/maplibre';

const MODES: { mode: MatchMode; title: string; line: string }[] = [
  { mode: 'classic', title: 'Classic', line: "Tagged? You're out. Watch live." },
  { mode: 'infection', title: 'Infection', line: 'Tagged? You join the Hunters.' },
];

export default function ModeSelectPage() {
  const router = useRouter();
  const [codename, setCodename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<MatchMode | null>(null);
  // B21: the setup map is one tap away — warm its chunk + style now,
  // at idle, so first paint does not pay the serial fetch wait.
  useEffect(() => {
    prefetchMapAssets();
  }, []);
  // The host MUST confirm they are at the play location — the server
  // rejects configs without `hostOnSiteConfirmed`, so this is a real
  // gate, never silently set true.
  const [onSite, setOnSite] = useState(false);

  const pick = async (mode: MatchMode): Promise<void> => {
    const name = codename.trim();
    if (!isValidDisplayName(name)) {
      setError('Enter a codename between 1 and 30 characters.');
      return;
    }
    if (!onSite) {
      setError("Confirm you're at the play location — the host must be on site to create a game.");
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
        hostOnSiteConfirmed: onSite,
        zone: {
          boundary: circlePolygon({ lat: 23.36, lng: 85.33 }, 500),
          shrinkPhases: [],
        },
      };
      if (isLiveTransportEnabled()) {
        const session = await createLiveRoom(name, config);
        router.push(`/room/${session.roomId}/setup`);
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
        router.push(`/room/${demo.room.roomId}/setup`);
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

      <button
        type="button"
        role="checkbox"
        aria-checked={onSite}
        onClick={() => {
          setOnSite((v) => !v);
          setError(null);
        }}
        className="mt-4 flex w-full items-start gap-3 rounded-[16px] border border-[#26262B] bg-[#141416] p-4 text-left"
      >
        <span
          aria-hidden
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border text-[13px] font-bold ${
            onSite ? 'border-[#EF4444] bg-[#EF4444] text-white' : 'border-[#26262B] bg-[#1E1E22] text-transparent'
          }`}
        >
          ✓
        </span>
        <span>
          <span className="block text-[15px] font-bold text-white">I&apos;m at the play location</span>
          <span className="mt-0.5 block text-[13px] text-[#A1A1AA]">
            The host must be on site — the game can&apos;t be created without this.
          </span>
        </span>
      </button>

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
