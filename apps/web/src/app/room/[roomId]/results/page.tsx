/**
 * Results — the match result (SCRAM-SPEC §10, PROTOCOL-MAP §3.4).
 *
 * Red hero, one-line stats, max-6 timeline, START A FRESH GAME. No
 * rematch, no share cards, no leaderboards, no per-player stats grid.
 *
 * Replay (v18): the host can send the same room/code back to the lobby
 * ("Replay — back to the lobby", `POST /v1/rooms/:id/replay` live /
 * `replayDemoRoom` demo). Non-hosts see a waiting line instead of a dead
 * button, and every client returns to the lobby when the room resets
 * (live `room.state` broadcast, demo 1 s poll).
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
import { fetchLiveResults, LiveHttpError, replayLiveRoom } from '@/lib/live-client';
import { goHomeAfterRoomDeleted } from '@/lib/room-deleted';
import { getRoom, replayDemoRoom } from '@/lib/demo-store';
import { formatDurationShort } from '@/lib/utils';

export default function ResultsPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const router = useRouter();

  // The socket is closed after a match, so results also works from a plain
  // state fetch (live) or the demo store — the hook's first paint covers it.
  const { mode, room, players, phase, loading, error, roomDeleted, seatRemoved, demo, session, myPlayer, myPlayerId, retryConnection, refreshDemo } = useRoomState(roomId);

  // Room deleted (founder decision, 2026-11-21): the host cancelled
  // and the room is gone — home with the one plain message. Declared
  // before the LOBBY effect below so a deletion never routes to the
  // lobby of a dead room on the way home.
  useEffect(() => {
    if (!roomDeleted) return;
    goHomeAfterRoomDeleted(router, roomId);
  }, [roomDeleted, roomId, router]);

  const result = room?.result ?? null;
  const isHost = myPlayer?.isHost ?? false;
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  // Replay-reset: when the room returns to LOBBY, go back to the same
  // lobby (same room, same code). Live arrives via the `room.state`
  // broadcast (`reason: "replay-reset"`) + snapshot; demo via the 1 s
  // poll. Guarded on loading/room: the hook's initial phase IS 'LOBBY'
  // before the first snapshot lands, and that must not redirect.
  useEffect(() => {
    if (loading || !room || roomDeleted) return;
    if (phase === 'LOBBY') {
      router.replace(`/room/${roomId}`);
    }
  }, [loading, room, phase, roomDeleted, roomId, router]);

  // Host-only replay (the server 403s a non-host; the demo store throws
  // the same way). On success the host navigates at once; every other
  // client follows via the effect above when the reset lands.
  const handleReplay = async () => {
    if (replaying) return;
    setReplayError(null);
    setReplaying(true);
    try {
      if (mode === 'live') {
        await replayLiveRoom(roomId);
      } else {
        const current = getRoom(roomId);
        if (!current) throw new Error('Game not found on this device.');
        replayDemoRoom(current, myPlayerId);
        refreshDemo();
      }
      router.replace(`/room/${roomId}`);
    } catch (err) {
      if (err instanceof LiveHttpError && err.status === 403) {
        setReplayError('Only the host can replay the room.');
      } else if (err instanceof Error) {
        setReplayError(err.message);
      } else {
        setReplayError('Could not replay — try again.');
      }
    } finally {
      setReplaying(false);
    }
  };

  // Scores (P1-27): live calls GET /v1/rooms/:id/results (the server
  // computes them); demo scores locally with the same engine rule.
  // B24: the fetch starts in parallel with the room-state first paint
  // (on mount, not after `result` lands) — it used to wait for the
  // room state and then run a second sequential GET. A 404 just means
  // no result exists yet; the effect re-runs when `result` arrives.
  const [liveScores, setLiveScores] = useState<Record<string, number> | null>(null);
  const [scoresError, setScoresError] = useState<string | null>(null);
  // v31 fix round (F3): the full `get-results` response for a removed
  // seat — `getStateOp` refuses them (403 `SEAT_REMOVED`), so the room
  // never loads, but `get-results` still serves a left seat. This is
  // what the removal branch below renders from: outcome, duration,
  // tags and MY score only. The full results screen (room code, mode,
  // named timeline, named scores) cannot render from this payload —
  // it carries playerIds, not display names — so that stays out of
  // reach for a removed seat until the server sends names (see the
  // branch below).
  const [liveResult, setLiveResult] = useState<Awaited<
    ReturnType<typeof fetchLiveResults>
  > | null>(null);
  // A 404 from `get-results` while removed = the match has not
  // finished yet (the effect below records it instead of spinning).
  const [liveResultMissing, setLiveResultMissing] = useState(false);
  // Retry nonce: re-runs the fetch below after a scores failure.
  const [scoresRetryNonce, setScoresRetryNonce] = useState(0);
  useEffect(() => {
    if (mode !== 'live' || !session?.reconnectToken) return;
    if (liveScores) return;
    let cancelled = false;
    fetchLiveResults(roomId, session.playerId, session.reconnectToken)
      .then((res) => {
        if (!cancelled) {
          setLiveScores(res.scores);
          setLiveResult(res);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 404 = no result recorded yet (match still running) — not an
        // error; the effect re-runs when `result` lands. Once a result
        // exists, a 404 is a real scores failure.
        if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404 && !result) {
          // v31 fix round (F3): a removed seat has no `result` to wait
          // for (the room never loads), so record "not finished yet"
          // instead of spinning on "Loading your result…" forever.
          if (seatRemoved) setLiveResultMissing(true);
          return;
        }
        setScoresError('Scores could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [mode, result, roomId, seatRemoved, session?.playerId, session?.reconnectToken, liveScores, scoresRetryNonce]);

  const retryScores = () => {
    setScoresError(null);
    setScoresRetryNonce((n) => n + 1);
  };

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
  // v31 fix round (F3): my seat was removed — the state fetch refused
  // it with 403 `SEAT_REMOVED`, so the room never loads. The match
  // result is still mine to see: `get-results` serves a left seat, and
  // this branch renders what that payload actually carries — the
  // outcome, the duration, the tag counts, and MY score (my own name
  // comes from the session). What it cannot show is the full results
  // screen: no room code, no mode, no named timeline, no named scores
  // — `get-results` carries playerIds, not display names. That needs
  // a server payload change (names in `get-results`, or a leaver-safe
  // state read), so it is deferred, not faked with opaque ids. No
  // Retry here: a removed seat can never reload the room.
  if (seatRemoved) {
    const removedResult = liveResult?.result ?? null;
    const removedTags = removedResult?.caughtRunnerIds.length ?? 0;
    const removedSurvivors = removedResult?.survivingRunnerIds.length ?? 0;
    const myScore = liveResult?.scores[myPlayerId] ?? 0;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-6 text-center text-[15px] font-semibold text-white">
          You were removed from the game.
        </p>
        <p className="text-center text-[14px] text-[#A1A1AA]">
          The host removed you from this game. Your result is still recorded — here is how your
          match ended.
        </p>
        {removedResult ? (
          <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
            <p className="text-[18px] font-bold text-white">
              {removedResult.outcome === 'hunters-win'
                ? 'Hunters Win!'
                : removedResult.outcome === 'runners-win'
                  ? 'Runners Win!'
                  : removedResult.outcome === 'cancelled'
                    ? 'Match cancelled'
                    : 'Match over'}
            </p>
            <p className="mt-1 text-[15px] text-[#A1A1AA]">
              {formatDurationShort(removedResult.durationSeconds)} · {removedTags} tag
              {removedTags === 1 ? '' : 's'}
              {removedSurvivors > 0
                ? ` · ${removedSurvivors} runner${removedSurvivors === 1 ? '' : 's'} never caught`
                : ''}
            </p>
            <p className="mt-2 text-[15px] font-semibold text-white">
              You scored {myScore} {myScore === 1 ? 'pt' : 'pts'}
            </p>
          </div>
        ) : liveResultMissing ? (
          <p className="text-center text-[15px] text-white">The match hasn&rsquo;t finished yet.</p>
        ) : scoresError ? (
          <p className="text-center text-[15px] text-white">Your result could not be loaded.</p>
        ) : (
          <p className="py-6 text-center text-[15px] text-[#A1A1AA]">Loading your result…</p>
        )}
        <Button variant="primary" onClick={() => router.push('/')}>
          Go home
        </Button>
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
          page never called the endpoint before. Highest first. While
          they load, a skeleton holds the space (B24) instead of the
          section popping in after the room state. */}
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
        <div className="flex flex-col gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-4">
          <p className="text-[14px] text-[#A1A1AA]">{scoresError}</p>
          <Button variant="outline" onClick={retryScores}>
            Retry
          </Button>
        </div>
      ) : mode === 'live' ? (
        <div
          className="rounded-2xl border border-[#26262B] bg-[#141416] p-4"
          aria-label="Loading scores"
        >
          <div className="mb-3 h-5 w-20 animate-pulse rounded bg-[#1E1E22]" />
          <div className="flex flex-col gap-2">
            <div className="h-5 w-full animate-pulse rounded bg-[#1E1E22]" />
            <div className="h-5 w-4/5 animate-pulse rounded bg-[#1E1E22]" />
            <div className="h-5 w-3/5 animate-pulse rounded bg-[#1E1E22]" />
          </div>
        </div>
      ) : null}

      {/* What happened — max 6, newest last. */}
      <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
        <h2 className="mb-3 text-[18px] font-bold text-white">What happened</h2>
        <ResultsTimeline events={events} />
      </div>

      {/* Replay — same room, same code, fresh game. Host-only: the
          server 403s a non-host, so non-hosts get the waiting line
          instead of a dead button, and return to the lobby when the host
          replays (the LOBBY effect above). */}
      {isHost ? (
        <Button variant="primary" onClick={() => void handleReplay()} disabled={replaying}>
          {replaying ? 'Replaying…' : 'Replay — back to the lobby'}
        </Button>
      ) : (
        <p className="text-center text-[14px] text-[#A1A1AA]">
          Only the host can replay — waiting for the host.
        </p>
      )}
      {replayError ? (
        <p className="text-center text-[14px] text-[#EF4444]">{replayError}</p>
      ) : null}

      <Button variant="primary" onClick={() => router.push('/')}>
        START A FRESH GAME
      </Button>
    </main>
  );
}
