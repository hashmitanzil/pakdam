import type { DemoRoom } from '@/lib/demo-store';
import type { CatchView, PlayerView, Room } from '@pakdam/shared';

/**
 * Monthly leaderboard scoring — Pakdam redesign v2 (2026-11-17).
 *
 * Points are computed ONLY from real match data stored on this device
 * (local demo rooms: `pakdam.demo.rooms.v1`). Nothing is invented:
 * a point is awarded only when the underlying match record exists.
 *
 * Rules (shown plainly on the profile page, same wording there):
 *   +1 per 3 minutes free, up to 10 per match
 *   +10 never caught in a finished match
 *   +3 per confirmed tag (as Hunter)
 *   +10 clean sweep — Hunters caught every Runner in a finished match
 *     (awarded to each Hunter in that match)
 *
 * Honesty limits, enforced here and surfaced to the UI:
 * - Only COMPLETED matches count. In-progress, cancelled or abandoned
 *   matches earn no points.
 * - Free time is measured from match start (when Hunters start moving)
 *   to when the Runner was caught, or to the match end for survivors.
 *   The head-start minutes are NOT counted: the demo store does not
 *   record a separate head-start start time, so counting them would be
 *   guessing. A Runner whose catch has no confirmation time, or a
 *   survivor in a match with no recorded end time, gets no free-time
 *   points for that match and the match is flagged `incompleteData`.
 * - A match result with duration 0 is treated as "no end time recorded",
 *   never as a 0-minute match.
 * - Only confirmed catches count. Requested / disputed / expired /
 *   rejected catches earn nothing.
 *
 * This module has NO runtime imports (type-only) so the scoring can be
 * unit-checked in isolation. It never reads location data: rooms persist
 * without coordinates, and nothing here touches them.
 */

/** Convert a demo room to the scoring input shape. Only fields the
 *  scoring rules need are carried over — never coordinates (rooms
 *  persist without them) and never anything invented. */
export function toScoringRoom(r: DemoRoom): ScoringRoom {
  return {
    roomId: r.room.roomId,
    roomCode: r.room.roomCode,
    phase: r.room.phase,
    createdAt: r.room.createdAt,
    startedAt: r.room.startedAt,
    endsAt: r.room.endsAt,
    resultDurationSeconds: r.room.result ? r.room.result.durationSeconds : null,
    resultOutcome: r.room.result ? r.room.result.outcome : null,
    players: r.players.map((p) => ({ playerId: p.playerId, displayName: p.displayName, matchRole: p.matchRole })),
    catches: r.catches.map((c) => ({
      hunterPlayerId: c.hunterPlayerId,
      runnerPlayerId: c.runnerPlayerId,
      state: c.state,
      confirmedAt: c.confirmedAt,
    })),
  };
}

/** LIVE (Worker) scoring input — ready, but NOT wired to any page yet.
 *
 *  Why not wired: NO live route returns everything scoring needs.
 *  The one live read route, GET /v1/rooms/:id?playerId= (workers/src/
 *  index.ts `get-state`), returns an AuthorisedSnapshot { room,
 *  players: PlayerView[], version } only — NO catches, and every seat
 *  except the requester's has matchRole/team null (role secrecy,
 *  MP-ROLE-LEAK). Points need confirmed catches + every player's role,
 *  so a board or a season total CANNOT be computed client-side from
 *  get-state: other players' roles are hidden and catches are absent.
 *
 *  What is needed (exact contract — see the report for Worker 6):
 *  GET /v1/rooms/:id/results (already spec'd in docs/API.md, HNT-030,
 *  NOT yet implemented in workers/src/index.ts) returning, for a
 *  participant of a COMPLETED room, { room, players (full matchRole
 *  for every seat — post-match reveal), catches: CatchView[] }.
 *  Feed exactly that into this function and the existing
 *  pointsForMatch / seasonPointsForPlayer / seasonBoard work unchanged.
 *  A server-side board (GET /v1/leaderboard) is still needed for the
 *  world/country board — the client must never be handed other
 *  players' opt-in state or raw match history to aggregate itself.
 *
 *  `catches` is a separate argument on purpose: get-state does not
 *  return catches, so no caller may silently pass an empty list and
 *  get 0-point rows that look real. */
export function toScoringRoomFromLive(
  room: Room,
  players: PlayerView[],
  catches: CatchView[],
): ScoringRoom {
  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    phase: room.phase,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    resultDurationSeconds: room.result ? room.result.durationSeconds : null,
    resultOutcome: room.result ? room.result.outcome : null,
    players: players.map((p) => ({ playerId: p.playerId, displayName: p.displayName, matchRole: p.matchRole })),
    catches: catches.map((c) => ({
      hunterPlayerId: c.hunterPlayerId,
      runnerPlayerId: c.runnerPlayerId,
      state: c.state,
      confirmedAt: c.confirmedAt,
    })),
  };
}

export interface ScoringPlayer {
  playerId: string;
  displayName: string;
  matchRole: 'hunter' | 'runner' | null;
}

export interface ScoringCatch {
  hunterPlayerId: string;
  runnerPlayerId: string;
  state: string;
  confirmedAt: string | null;
}

export interface ScoringRoom {
  roomId: string;
  roomCode: string;
  phase: string;
  createdAt: string;
  startedAt: string | null;
  endsAt: string | null;
  resultDurationSeconds: number | null;
  resultOutcome: string | null;
  players: ScoringPlayer[];
  catches: ScoringCatch[];
}

export interface MatchPoints {
  roomId: string;
  roomCode: string;
  playedAt: string;
  role: 'hunter' | 'runner' | null;
  freeMinutes: number | null;
  freePoints: number;
  neverCaughtPoints: number;
  tagPoints: number;
  tags: number;
  cleanSweepPoints: number;
  total: number;
  incompleteData: boolean;
  incompleteReason: string | null;
}

export interface SeasonPoints {
  total: number;
  matchesCounted: number;
  matchesSkippedNotFinished: number;
  matchesIncompleteData: number;
  byMatch: MatchPoints[];
}

export const POINTS_RULES = {
  freePer3Min: 1,
  freeMaxPerMatch: 10,
  neverCaught: 10,
  perTag: 3,
  cleanSweep: 10,
} as const;

/** End of a match, in ms since epoch, or null when no end time was recorded. */
export function matchEndMs(room: ScoringRoom): number | null {
  if (room.endsAt) {
    const t = Date.parse(room.endsAt);
    if (!Number.isNaN(t)) return t;
  }
  if (room.startedAt && room.resultDurationSeconds !== null && room.resultDurationSeconds > 0) {
    const s = Date.parse(room.startedAt);
    if (!Number.isNaN(s)) return s + room.resultDurationSeconds * 1000;
  }
  return null;
}

function confirmedCatches(room: ScoringRoom): ScoringCatch[] {
  return room.catches.filter((c) => c.state === 'confirmed');
}

function isCleanSweep(room: ScoringRoom): boolean {
  const runners = room.players.filter((p) => p.matchRole === 'runner');
  if (runners.length === 0) return false;
  const caught = new Set(confirmedCatches(room).map((c) => c.runnerPlayerId));
  return runners.every((r) => caught.has(r.playerId));
}

/** Points for one player in one room. Returns null when the room is not
 *  COMPLETED (no points are earned in unfinished matches). */
export function pointsForMatch(room: ScoringRoom, playerId: string): MatchPoints | null {
  if (room.phase !== 'COMPLETED') return null;
  const me = room.players.find((p) => p.playerId === playerId);
  if (!me) return null;
  const confirmed = confirmedCatches(room);
  const caughtIds = new Set(confirmed.map((c) => c.runnerPlayerId));
  const startMs = room.startedAt ? Date.parse(room.startedAt) : NaN;

  let freeMinutes: number | null = null;
  let freePoints = 0;
  let incompleteData = false;
  let incompleteReason: string | null = null;

  if (me.matchRole === 'runner') {
    if (Number.isNaN(startMs)) {
      incompleteData = true;
      incompleteReason = 'Match start time was not recorded, so free time could not be measured.';
    } else if (caughtIds.has(playerId)) {
      const myCatch = confirmed
        .filter((c) => c.runnerPlayerId === playerId)
        .sort((a, b) => Date.parse(a.confirmedAt ?? '') - Date.parse(b.confirmedAt ?? ''))[0];
      const caughtMs = myCatch?.confirmedAt ? Date.parse(myCatch.confirmedAt) : NaN;
      if (Number.isNaN(caughtMs) || caughtMs < startMs) {
        incompleteData = true;
        incompleteReason = 'Catch time was not recorded, so free time could not be measured.';
      } else {
        freeMinutes = Math.max(0, Math.floor((caughtMs - startMs) / 60000));
      }
    } else {
      const endMs = matchEndMs(room);
      if (endMs === null || endMs < startMs) {
        incompleteData = true;
        incompleteReason = 'Match end time was not recorded, so free time could not be measured.';
      } else {
        freeMinutes = Math.max(0, Math.floor((endMs - startMs) / 60000));
      }
    }
    if (freeMinutes !== null) {
      freePoints = Math.min(POINTS_RULES.freeMaxPerMatch, Math.floor(freeMinutes / 3) * POINTS_RULES.freePer3Min);
    }
  }

  const neverCaughtPoints =
    me.matchRole === 'runner' && !caughtIds.has(playerId) ? POINTS_RULES.neverCaught : 0;
  const tags = me.matchRole === 'hunter' ? confirmed.filter((c) => c.hunterPlayerId === playerId).length : 0;
  const tagPoints = tags * POINTS_RULES.perTag;
  const cleanSweepPoints =
    me.matchRole === 'hunter' && isCleanSweep(room) ? POINTS_RULES.cleanSweep : 0;

  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    playedAt: room.createdAt,
    role: me.matchRole,
    freeMinutes,
    freePoints,
    neverCaughtPoints,
    tagPoints,
    tags,
    cleanSweepPoints,
    total: freePoints + neverCaughtPoints + tagPoints + cleanSweepPoints,
    incompleteData,
    incompleteReason,
  };
}

/** Season points for one player across rooms. `season` is the calendar
 *  month (0-based) and year the room was created in. Only rooms in that
 *  month count; only COMPLETED rooms earn points. */
export function seasonPointsForPlayer(
  rooms: ScoringRoom[],
  playerId: string,
  month: number,
  year: number,
): SeasonPoints {
  const inSeason = rooms.filter((r) => {
    const d = new Date(r.createdAt);
    return d.getMonth() === month && d.getFullYear() === year;
  });
  const byMatch: MatchPoints[] = [];
  let skipped = 0;
  for (const room of inSeason) {
    const played = room.players.some((p) => p.playerId === playerId);
    if (!played) continue;
    const pts = pointsForMatch(room, playerId);
    if (pts === null) {
      skipped += 1;
    } else {
      byMatch.push(pts);
    }
  }
  byMatch.sort((a, b) => Date.parse(b.playedAt) - Date.parse(a.playedAt));
  return {
    total: byMatch.reduce((sum, m) => sum + m.total, 0),
    matchesCounted: byMatch.length,
    matchesSkippedNotFinished: skipped,
    matchesIncompleteData: byMatch.filter((m) => m.incompleteData).length,
    byMatch,
  };
}

// --- Friends + "Played with" (last 7 days) ---------------------------------

export interface PlayedWithEntry {
  /** Grouped by display name: the same person rejoining gets a new
   *  player id, so names are the only stable key on this device. */
  displayName: string;
  gamesTogether: number;
  lastPlayedAt: string;
  roles: string[];
}

export interface FriendRecord {
  displayName: string;
  addedAt: string;
}

/**
 * People the player shared a room with in the last `days` days, from real
 * local match history only. `myPlayerIds` are all player ids that belong
 * to this device's player (one per room they joined). Returns one entry
 * per display name, most recent first. No locations, no contact details.
 */
export function playedWith(
  rooms: ScoringRoom[],
  myPlayerIds: Set<string>,
  days = 7,
  nowMs: number = Date.now(),
): PlayedWithEntry[] {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const byName = new Map<string, PlayedWithEntry>();
  for (const room of rooms) {
    const createdMs = Date.parse(room.createdAt);
    if (Number.isNaN(createdMs) || createdMs < cutoff) continue;
    if (!room.players.some((p) => myPlayerIds.has(p.playerId))) continue;
    for (const p of room.players) {
      if (myPlayerIds.has(p.playerId)) continue;
      const key = p.displayName.trim().toLowerCase();
      if (!key) continue;
      const existing = byName.get(key);
      if (existing) {
        existing.gamesTogether += 1;
        if (createdMs > Date.parse(existing.lastPlayedAt)) existing.lastPlayedAt = room.createdAt;
        if (p.matchRole && !existing.roles.includes(p.matchRole)) existing.roles.push(p.matchRole);
      } else {
        byName.set(key, {
          displayName: p.displayName.trim(),
          gamesTogether: 1,
          lastPlayedAt: room.createdAt,
          roles: p.matchRole ? [p.matchRole] : [],
        });
      }
    }
  }
  return [...byName.values()].sort(
    (a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt),
  );
}

/** Enrich a local friends list with real shared-game counts from history. */
export function friendsWithHistory(
  friends: FriendRecord[],
  rooms: ScoringRoom[],
  myPlayerIds: Set<string>,
): (FriendRecord & { gamesTogether: number; lastPlayedAt: string | null })[] {
  const history = playedWith(rooms, myPlayerIds, 3650);
  const byName = new Map(history.map((h) => [h.displayName.trim().toLowerCase(), h]));
  return friends.map((f) => {
    const h = byName.get(f.displayName.trim().toLowerCase());
    return {
      ...f,
      gamesTogether: h?.gamesTogether ?? 0,
      lastPlayedAt: h?.lastPlayedAt ?? null,
    };
  });
}

// --- Season board (all players, top-100 style) ---------------------------

export interface BoardRow {
  /** Grouped by player id within a room; the same person rejoining a
   *  later game gets a new id, so a name can appear more than once in
   *  the demo — the board never merges people it cannot prove are one
   *  person. */
  playerId: string;
  displayName: string;
  /** True for "(demo)" practice players added to a room on this device. */
  isDemo: boolean;
  total: number;
  matchesCounted: number;
  /** Country is only ever known for this device's own player (stored in
   *  profile); every other row is null — the board never guesses it. */
  country: string | null;
}

/**
 * Season board for every player with at least one COMPLETED match in
 * the month, computed from real local match data only (same rules as
 * seasonPointsForPlayer). Sorted by points, highest first, capped at
 * 100 rows. Rows are DEMO rows when the player is a "(demo)" practice
 * player; the caller labels them as such. No location, no dates, no
 * game times are ever attached to a row.
 */
export function seasonBoard(
  rooms: ScoringRoom[],
  month: number,
  year: number,
  myCountry: string | null,
  myPlayerIds: Set<string>,
): BoardRow[] {
  const byPlayer = new Map<string, { displayName: string; total: number; matches: number }>();
  const inSeason = rooms.filter((r) => {
    const d = new Date(r.createdAt);
    return d.getMonth() === month && d.getFullYear() === year;
  });
  for (const room of inSeason) {
    for (const p of room.players) {
      const pts = pointsForMatch(room, p.playerId);
      if (!pts) continue;
      const existing = byPlayer.get(p.playerId);
      if (existing) {
        existing.total += pts.total;
        existing.matches += 1;
      } else {
        byPlayer.set(p.playerId, { displayName: p.displayName, total: pts.total, matches: 1 });
      }
    }
  }
  return [...byPlayer.entries()]
    .map(([playerId, v]) => ({
      playerId,
      displayName: v.displayName,
      isDemo: v.displayName.trim().endsWith('(demo)'),
      total: v.total,
      matchesCounted: v.matches,
      country: myPlayerIds.has(playerId) ? myCountry : null,
    }))
    .sort((a, b) => b.total - a.total || b.matchesCounted - a.matchesCounted || a.displayName.localeCompare(b.displayName))
    .slice(0, 100);
}
