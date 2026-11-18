import type { DemoRoom } from '@/lib/demo-store';
import type { CatchView, PlayerView, Room } from '@pakdam/shared';
import { describeMode, modeTurnsRunner } from '@pakdam/engine';

/**
 * Shareable round card, built from one finished game stored on this
 * device — the same recap the results page shows, in Pakdam's own
 * words, so a card shared from your profile says exactly what the
 * results page said.
 *
 * Moments and counts only: outcome, caught / still-free counts,
 * confirmed catches, most tags, never caught, clean sweep, duration.
 * NO positions, NO routes, NO locations — location data is deleted at
 * match end and nothing here invents it. Every number comes from the
 * room record; a missing value is shown as "not recorded", never guessed.
 *
 * Pure functions (no storage, no clipboard) so the text can be checked
 * without a browser. `ShareRoundCard.tsx` renders the visual card and
 * owns the copy button.
 */

export interface RoundCardSummary {
  outcomeLabel: string;
  modeLabel: string;
  turns: boolean;
  caughtWord: string;
  playerCount: number;
  runnerCount: number;
  caughtCount: number;
  survivorNames: string[];
  ejectedNames: string[];
  confirmedCount: number;
  topHunter: { displayName: string; tags: number } | null;
  neverCaughtNames: string[];
  cleanSweep: boolean;
  durationLabel: string;
  disputedCount: number;
}

/** Summarise one room into the numbers and names a round card shows. */
export function summarizeRound(dr: DemoRoom): RoundCardSummary {
  return summarizeRoundFromLive(dr.room, dr.players, dr.catches);
}

/** LIVE (Worker) round summary — same numbers, from the live shapes.
 *
 *  Ready, but NOT wired to any page yet: no live route returns
 *  catches. GET /v1/rooms/:id?playerId= (get-state) returns { room,
 *  players, version } only — no catches, and other seats' matchRole
 *  is null (role secrecy), so runners / top Hunter / clean sweep
 *  cannot be derived from it. What is needed (exact contract — see
 *  the report for Worker 6): GET /v1/rooms/:id/results (spec'd in
 *  docs/API.md, HNT-030, NOT yet implemented) returning, for a
 *  participant of a COMPLETED room, { room, players (full matchRole
 *  for every seat — post-match reveal), catches: CatchView[] }.
 *  Feed exactly that into this function (or buildRoundCardTextFromLive)
 *  and the card renders identically to the demo one. */
export function summarizeRoundFromLive(
  room: Room,
  players: PlayerView[],
  catches: CatchView[],
): RoundCardSummary {
  const confirmed = catches.filter((c) => c.state === 'confirmed');
  const caughtIds = confirmed.map((c) => c.runnerPlayerId);
  const runners = players.filter((p) => p.matchRole === 'runner');
  const survivors = runners.filter((r) => !caughtIds.includes(r.playerId) && !r.ejectedAt);
  const ejectedRunners = runners.filter((r) => r.ejectedAt);
  const disputed = catches.filter((c) => c.state === 'disputed');
  const outcome =
    room.result?.outcome ??
    (runners.length > 0 && survivors.length === 0
      ? 'hunters-win'
      : room.phase === 'COMPLETED'
        ? 'runners-win'
        : 'in progress');
  const outcomeLabel =
    outcome === 'hunters-win'
      ? 'Hunters win'
      : outcome === 'runners-win'
        ? 'Runners win'
        : outcome === 'cancelled'
          ? 'Match cancelled'
          : outcome === 'abandoned'
            ? 'Match abandoned'
            : 'Match in progress';
  const turns = modeTurnsRunner(room.config.mode);
  const catchCounts = new Map<string, number>();
  for (const c of confirmed) catchCounts.set(c.hunterPlayerId, (catchCounts.get(c.hunterPlayerId) ?? 0) + 1);
  const topHunterEntry = [...catchCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topHunterPlayer = topHunterEntry
    ? players.find((p) => p.playerId === topHunterEntry[0])
    : null;
  // A clean sweep needs every Runner CAUGHT: ejected Runners are out,
  // not caught, so they break the sweep.
  const cleanSweep =
    runners.length > 0 && survivors.length === 0 && ejectedRunners.length === 0;
  return {
    outcomeLabel,
    modeLabel: describeMode(room.config.mode).label,
    turns,
    caughtWord: turns ? 'Turned' : 'Caught',
    playerCount: players.length,
    runnerCount: runners.length,
    caughtCount: caughtIds.length,
    survivorNames: survivors.map((s) => s.displayName),
    ejectedNames: ejectedRunners.map((e) => e.displayName),
    confirmedCount: confirmed.length,
    topHunter:
      topHunterPlayer && topHunterEntry
        ? { displayName: topHunterPlayer.displayName, tags: topHunterEntry[1] }
        : null,
    neverCaughtNames: survivors.map((s) => s.displayName),
    cleanSweep,
    durationLabel: room.result?.durationSeconds
      ? `${Math.round(room.result.durationSeconds / 60)} min`
      : 'not recorded',
    disputedCount: disputed.length,
  };
}

/** Plain-text recap to copy and paste wherever your group already chats. */
export function buildRoundCardText(dr: DemoRoom): string {
  return buildRoundCardTextFromLive(dr.room, dr.players, dr.catches);
}

/** LIVE (Worker) round-card text — same words, from the live shapes.
 *  Same wiring note as summarizeRoundFromLive: needs
 *  GET /v1/rooms/:id/results (spec'd, not implemented) returning
 *  { room, players, catches: CatchView[] }. */
export function buildRoundCardTextFromLive(room: Room, players: PlayerView[], catches: CatchView[]): string {
  const s = summarizeRoundFromLive(room, players, catches);
  return [
    'PAKDAM — round recap',
    `${s.outcomeLabel} · ${s.modeLabel} · Room ${room.roomCode}`,
    `${s.caughtWord} Runners: ${s.caughtCount} of ${s.runnerCount} · Survivors: ${s.survivorNames.join(', ') || 'none'}${s.ejectedNames.length > 0 ? ` · Ejected: ${s.ejectedNames.join(', ')}` : ''}`,
    `Confirmed catches: ${s.confirmedCount}${s.topHunter ? ` · Most tags: ${s.topHunter.displayName} (${s.topHunter.tags})` : ''}`,
    `${s.neverCaughtNames.length > 0 ? `Never caught: ${s.neverCaughtNames.join(', ')}` : 'Never caught: nobody — every Runner was caught'}`,
    `${s.cleanSweep ? 'Clean sweep — every Runner caught' : 'No clean sweep this round'}`,
    `Duration: ${s.durationLabel}`,
    'No locations or routes are shared — locations are deleted at match end.',
  ].join('\n');
}
