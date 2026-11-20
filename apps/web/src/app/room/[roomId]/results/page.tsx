/**
 * Results — the match result (SCRAM-SPEC §10, PROTOCOL-MAP §3.4).
 *
 * Red hero, one-line stats, max-6 timeline, START A FRESH GAME. No
 * rematch, no share cards, no leaderboards, no per-player stats grid.
 *
 * Honesty rule: caught / surviving membership comes from `room.result`
 * only, never from roles. Per-tag entries come from `result.tags` (live
 * and demo) — each confirmed tag carries who tagged whom and when.
 */
'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { scoreMatch } from '@pakdam/engine';
import { useRoomState } from '@/components/match/useRoomState';
import { ResultsTimeline, type TimelineEvent } from '@/components/catch/ResultsTimeline';
import { Button } from '@/components/ui/Button';
import { fetchLiveResults } from '@/lib/live-client';
import { formatDurationShort } from '@/lib/utils';

export default function ResultsPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const router = useRouter();

  // The socket is closed after a match, so results also works from a plain
  // state fetch (live) or the demo store — the hook's first paint covers it.
  const { mode, room, players, phase, loading, error, demo, session, retryConnection } = useRoomState(roomId);

  const result = room?.result ?? null;

  // Scores (P1-27): live calls GET /v1/rooms/:id/results (the server
  // computes them); demo scores locally with the same engine rule.
  const [liveScores, setLiveScores] = useState<Record<string, number> | null>(null);
  const [scoresError, setScoresError] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'live' || !result || !session?.reconnectToken) return;
    let cancelled = false;
    fetchLiveResults(roomId, session.playerId, session.reconnectToken)
      .then((res) => {
        if (!cancelled) setLiveScores(res.scores);
      })
      .catch(() => {
        if (!cancelled) setScoresError('Scores could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [mode, result, roomId, session?.playerId, session?.reconnectToken]);

  const demoScores = useMemo(() => {
    if (mode !== 'demo' || !demo || !result) return null;
    const startedAtMs = room?.startedAt ? Date.parse(room.startedAt) : null;
    const endedAtMs =
      startedAtMs !== null ? startedAtMs + result.durationSeconds * 1000 : Date.now();
    const caught = new Set(
      demo.catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId),
    );
    return scoreMatch({
      players: players.map((p) => {
        const freeUntil =
          p.matchRole === 'runner'
            ? p.ejectedAt !== null
              ? Date.parse(p.ejectedAt)
              : caught.has(p.playerId)
                ? Date.parse(
                    demo.catches.find(
                      (c) => c.runnerPlayerId === p.playerId && c.state === 'confirmed',
                    )?.confirmedAt ?? new Date(endedAtMs).toISOString(),
                  )
                : endedAtMs
            : endedAtMs;
        return {
          playerId: p.playerId,
          matchRole: p.matchRole,
          freeSeconds:
            startedAtMs === null
              ? 0
              : Math.max(0, Math.floor((freeUntil - startedAtMs) / 1000)),
          caught: caught.has(p.playerId),
          ejected: p.ejectedAt !== null,
          tagsMade: demo.catches.filter(
            (c) => c.hunterPlayerId === p.playerId && c.state === 'confirmed',
          ).length,
        };
      }),
      result,
      ejectedRunnerIds: players.filter((p) => p.ejectedAt !== null).map((p) => p.playerId),
    }).scores;
  }, [mode, demo, result, players, room?.startedAt]);

  const scores = mode === 'live' ? liveScores : demoScores;

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
        {/* A transient first-paint GET failure must not dead-end the
            screen — Retry re-requests the snapshot (P1-23). */}
        <Button variant="primary" onClick={retryConnection}>
          Retry
        </Button>
        <Button variant="outline" onClick={() => router.push('/')}>
          Go home
        </Button>
      </main>
    );
  }

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

  // Timeline: start + one entry per confirmed tag + end. Tag entries come
  // from `result.tags` (live and demo). A result saved before tags existed
  // has an empty list — demo falls back to its own catch records so an old
  // persisted demo room still shows its tags.
  const tagEntries: Array<{ hunterPlayerId: string; runnerPlayerId: string; confirmedAt: string }> =
    result.tags.length > 0
      ? result.tags
      : mode === 'demo' && demo
        ? demo.catches
            .filter((c) => c.state === 'confirmed' && c.confirmedAt)
            .map((c) => ({
              hunterPlayerId: c.hunterPlayerId,
              runnerPlayerId: c.runnerPlayerId,
              confirmedAt: c.confirmedAt as string,
            }))
        : [];
  // "Match started — N players" counts the roster AT MATCH START, not
  // the players still present at results time: joined by startedAt and
  // not left before it. (A player who left mid-match still played.)
  const startRosterCount =
    startedAtMs === null
      ? players.length
      : players.filter((p) => {
          if (Date.parse(p.joinedAt) > startedAtMs) return false;
          return p.leftAt === null || Date.parse(p.leftAt) >= startedAtMs;
        }).length;

  const events: TimelineEvent[] = [];
  events.push({
    atSeconds: 0,
    text: `Match started — ${startRosterCount} players`,
  });
  // Tag entries are added even when `startedAt` is unknown: a result
  // implies the match started, but a null `startedAt` must never silently
  // drop the tags. Without a start time the offset is unknowable, so those
  // tags sit at 0 s (right after "Match started") instead of vanishing.
  for (const tag of tagEntries) {
    const hunter = players.find((p) => p.playerId === tag.hunterPlayerId)?.displayName ?? 'A Hunter';
    const runner = players.find((p) => p.playerId === tag.runnerPlayerId)?.displayName ?? 'a Runner';
    events.push({
      atSeconds:
        startedAtMs !== null
          ? Math.max(
              0,
              Math.floor((new Date(tag.confirmedAt).getTime() - startedAtMs) / 1000),
            )
          : 0,
      text: `${hunter} tagged ${runner}`,
    });
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

      {/* Scores (P1-27): the server computes them (GET …/results); the
          page never called the endpoint before. Highest first. */}
      {scores ? (
        <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
          <h2 className="mb-3 text-[18px] font-bold text-white">Scores</h2>
          <ul className="flex flex-col gap-2">
            {[...players]
              .map((p) => ({
                playerId: p.playerId,
                displayName: p.displayName,
                points: scores[p.playerId] ?? 0,
              }))
              .sort((a, b) => b.points - a.points)
              .map((entry) => (
                <li
                  key={entry.playerId}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="min-w-0 truncate text-[15px] font-semibold text-white">
                    {entry.displayName}
                  </span>
                  <span className="text-[15px] font-bold text-white pakdam-numeric">
                    {entry.points} {entry.points === 1 ? 'pt' : 'pts'}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : scoresError ? (
        <p className="text-[14px] text-[#A1A1AA]">{scoresError}</p>
      ) : null}

      {/* What happened — max 6, newest last. */}
      <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
        <h2 className="mb-3 text-[18px] font-bold text-white">What happened</h2>
        <ResultsTimeline events={events} />
      </div>

      <Button variant="primary" onClick={() => router.push('/')}>
        START A FRESH GAME
      </Button>
    </main>
  );
}
