/**
 * Results — the match result (SCRAM-SPEC §10, PROTOCOL-MAP §3.4).
 *
 * Red hero, one-line stats, max-6 timeline, START A FRESH GAME. No
 * rematch, no share cards, no leaderboards, no per-player stats grid.
 *
 * Honesty rule: caught / surviving membership comes from `room.result`
 * only, never from roles. Per-tag times exist in demo (the store keeps
 * them); live results have none — the snapshot never carries confirmed
 * catches — so a live timeline is short rather than invented.
 */
'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { useRoomState } from '@/components/match/useRoomState';
import { ResultsTimeline, type TimelineEvent } from '@/components/catch/ResultsTimeline';
import { Button } from '@/components/ui/Button';
import { formatDurationShort } from '@/lib/utils';

export default function ResultsPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const router = useRouter();

  // The socket is closed after a match, so results also works from a plain
  // state fetch (live) or the demo store — the hook's first paint covers it.
  const { mode, room, players, phase, loading, error, demo } = useRoomState(roomId);

  if (loading) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-10 text-center text-[15px] text-[#A1A1AA]">Loading results…</p>
      </main>
    );
  }
  if (error || !room) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-6 text-center text-[15px] text-white">
          {error ?? 'No live seat saved on this device for this room.'}
        </p>
        <Button variant="primary" onClick={() => router.push('/')}>
          Go home
        </Button>
      </main>
    );
  }

  const result = room.result;
  const startedAtMs = room.startedAt ? new Date(room.startedAt).getTime() : null;

  if (!result) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-4 px-4 pt-3">
        <p className="py-6 text-center text-[15px] text-white">
          {phase === 'COMPLETED'
            ? 'The match finished, but no result was recorded.'
            : 'Match hasn\u2019t finished yet.'}
        </p>
        {phase !== 'COMPLETED' && phase !== 'CANCELLED' && phase !== 'ABANDONED' && phase !== 'EXPIRED' ? (
          <Button variant="primary" onClick={() => router.push(`/room/${roomId}/play`)}>
            Back to the match
          </Button>
        ) : (
          <Button variant="primary" onClick={() => router.push('/')}>
            Go home
          </Button>
        )}
      </main>
    );
  }

  const outcomeLabel =
    result.outcome === 'hunters-win'
      ? 'Hunters Win!'
      : result.outcome === 'runners-win'
        ? 'Runners Win!'
        : result.outcome === 'cancelled'
          ? 'Match cancelled'
          : 'Match over';
  const modeLabel = room.config.mode === 'classic' ? 'Classic Mode' : 'Infection Mode';
  const tags = result.caughtRunnerIds.length;
  const survivors = result.survivingRunnerIds.length;
  const stats = `${formatDurationShort(result.durationSeconds)} · ${tags} tag${tags === 1 ? '' : 's'}${survivors > 0 ? ` · ${survivors} runner${survivors === 1 ? '' : 's'} never caught` : ''}`;

  // Timeline: start + per-tag times (demo only — live has none) + end.
  const events: TimelineEvent[] = [];
  events.push({
    atSeconds: 0,
    text: `Match started — ${players.filter((p) => p.leftAt === null).length} players`,
  });
  if (mode === 'demo' && demo && startedAtMs !== null) {
    for (const c of demo.catches.filter((x) => x.state === 'confirmed' && x.confirmedAt)) {
      const hunter = players.find((p) => p.playerId === c.hunterPlayerId)?.displayName ?? 'A Hunter';
      const runner = players.find((p) => p.playerId === c.runnerPlayerId)?.displayName ?? 'a Runner';
      events.push({
        atSeconds: Math.max(
          0,
          Math.floor((new Date(c.confirmedAt as string).getTime() - startedAtMs) / 1000),
        ),
        text: `${hunter} tagged ${runner}`,
      });
    }
  }
  events.push({
    atSeconds: result.durationSeconds,
    text:
      result.outcome === 'hunters-win'
        ? 'Last runner caught'
        : result.outcome === 'runners-win'
          ? 'Time up — runners win'
          : 'Match ended',
  });
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-4 px-4 pb-8 pt-3">
      {/* Hero card (red). */}
      <div className="rounded-2xl bg-[#EF4444] p-5 text-white">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/70">MATCH OVER</p>
        <h1 className="pakdam-display mt-2 text-[44px]">{outcomeLabel}</h1>
        <p className="mt-2 text-[15px] text-white/85">
          {modeLabel} · Room {room.roomCode}
        </p>
      </div>

      {/* One-line stats — no grid. */}
      <p className="text-[15px] text-[#A1A1AA]">{stats}</p>

      {/* What happened — max 6, newest last. */}
      <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
        <h2 className="mb-3 text-[18px] font-bold text-white">What happened</h2>
        <ResultsTimeline events={events} />
        {mode === 'live' ? (
          <p className="mt-3 text-[13px] text-[#A1A1AA]">
            Tag times aren&apos;t kept after the match.
          </p>
        ) : null}
      </div>

      <Button variant="primary" onClick={() => router.push('/')}>
        START A FRESH GAME
      </Button>
    </main>
  );
}
