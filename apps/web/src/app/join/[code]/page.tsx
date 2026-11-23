'use client';

/**
 * Deep-link join — the code comes from the URL (`/join/<CODE>`), the
 * player only enters a codename, JOIN → the lobby. Guest-only, no login.
 * Same one-call join path as /join (PROTOCOL-MAP §1.2–1.3).
 */
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { isValidDisplayName, isValidRoomCode } from '@pakdam/shared';
import { isLiveTransportEnabled } from '../../../lib/websocket';
import { joinLiveRoomByCode } from '../../../lib/live-client';
import { getRoomByCode, joinRoom as joinDemoRoom } from '../../../lib/demo-store';
import {
  getSessionForRoomCode,
  storeDemoSeat,
  storeLiveSeat,
} from '../../../lib/session-credentials';
import { getRejoinTokenForCode } from '../../../lib/rejoin-token';

export default function JoinByCodePage() {
  const router = useRouter();
  const params = useParams();
  const rawCode = typeof params.code === 'string' ? params.code : '';
  const code = rawCode.trim().toUpperCase();
  const [codename, setCodename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  // v29 (A): a stored rejoin token for this code — a "Rejoin your
  // game" entry that restores the seat and navigates to the room, so
  // the existing resume path runs (role/score intact).
  const rejoinEntry = code ? getRejoinTokenForCode(code) : null;
  const handleRejoin = (): void => {
    if (!rejoinEntry) return;
    storeLiveSeat({
      mode: 'live',
      roomId: rejoinEntry.roomId,
      playerId: rejoinEntry.playerId,
      displayName: rejoinEntry.displayName,
      reconnectToken: rejoinEntry.reconnectToken,
      isHost: rejoinEntry.isHost,
      roomCode: rejoinEntry.roomCode,
    });
    router.push(`/room/${rejoinEntry.roomId}`);
  };

  const join = async (): Promise<void> => {
    if (!isValidRoomCode(code)) {
      setError("That code didn't match a room — check it and try again.");
      return;
    }
    const name = codename.trim();
    if (!isValidDisplayName(name)) {
      setError('Enter a codename between 1 and 30 characters.');
      return;
    }
    setError(null);
    setJoining(true);
    try {
      if (isLiveTransportEnabled()) {
        const existing = getSessionForRoomCode(code);
        const restoreToken =
          existing?.displayName?.toLowerCase() === name.toLowerCase()
            ? existing.reconnectToken
            : undefined;
        const session = await joinLiveRoomByCode(name, code, restoreToken);
        router.push(`/room/${session.roomId}`);
      } else {
        const demo = getRoomByCode(code);
        if (!demo) throw new Error("That code didn't match a room — check it and try again.");
        const { player } = joinDemoRoom(demo.room.roomId, name);
        storeDemoSeat({
          mode: 'demo',
          roomId: demo.room.roomId,
          playerId: player.playerId,
          displayName: name,
          isHost: player.isHost,
          roomCode: demo.room.roomCode,
        });
        router.push(`/room/${demo.room.roomId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join — try again.');
      setJoining(false);
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
        <h1 className="flex-1 text-center text-[18px] font-bold text-white">Join a game</h1>
        <span className="w-6" aria-hidden />
      </header>

      <p className="mt-6 text-center">
        <span className="pakdam-label block">Room code</span>
        <span className="pakdam-code mt-2 block text-white">{code || '——————'}</span>
      </p>
      <label className="mt-4 block">
        <span className="pakdam-label">Your codename</span>
        <input
          value={codename}
          onChange={(event) => {
            setCodename(event.target.value.slice(0, 30));
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void join();
          }}
          placeholder="e.g. Ana"
          autoComplete="off"
          autoFocus
          className="mt-2 h-14 w-full rounded-[14px] border border-[#26262B] bg-[#1E1E22] px-4 text-[17px] font-bold text-white placeholder:text-[#A1A1AA]"
        />
      </label>
      {error ? <p className="mt-2 text-[13px] text-[#EF4444]">{error}</p> : null}

      {/* v29 (A): "Rejoin your game" — a stored seat for this code.
          One tap restores it with role and score intact, instead of
          joining as a new player. */}
      {rejoinEntry ? (
        <div className="mt-6">
          <button
            type="button"
            onClick={handleRejoin}
            className="flex w-full items-center justify-between rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-left"
          >
            <span>
              <span className="block text-[15px] font-bold text-white">
                Rejoin your game — {rejoinEntry.displayName}
              </span>
              <span className="mt-0.5 block text-[13px] text-[#A1A1AA]">
                Room {rejoinEntry.roomCode} · tap to rejoin with your role and score
              </span>
            </span>
            <span aria-hidden className="text-[20px] text-[#EF4444]">
              →
            </span>
          </button>
        </div>
      ) : null}

      <div className="mt-6">
        <button
          type="button"
          disabled={joining}
          onClick={() => void join()}
          className="inline-flex h-14 w-full items-center justify-center rounded-[14px] bg-[#EF4444] text-[17px] font-bold text-white active:bg-[#DC2626] disabled:opacity-60"
        >
          {joining ? 'Joining…' : 'JOIN'}
        </button>
      </div>
    </main>
  );
}
