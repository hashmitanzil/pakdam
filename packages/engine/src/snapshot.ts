/**
 * Pakdam engine — snapshot building with ROLE SECRECY.
 *
 * A snapshot is the whole truth the UI renders — and it NEVER carries an
 * opponent's coordinates, pending pings, or token hashes. Pings arrive
 * only as `ping` events after connect; a reconnect loses earlier pings.
 *
 * Role secrecy: each player sees only their OWN role/team; every other
 * seat's role is `null` (the Hunter's catch picker shows names only;
 * caught/survivor lists come from `room.result` only). The reconnect-token
 * hash is stripped for every seat, including the viewer's own.
 *
 * The one exception to "no coordinates": `teammateFixes` carries the
 * viewer's OWN teammates' latest live fixes (teammates see each other
 * live). Opponents are never in it — they are ping-only. A caught Runner
 * (Classic, confirmed catch, still a Runner) gets an empty teammate view:
 * once tagged, they can no longer see the untagged runners' live
 * locations, and as a spectator they see both teams only via pings.
 * (Infection flips a tagged Runner to Hunter, so they are a Hunter, not
 * a caught spectator — this exclusion only applies while the viewer is
 * still a Runner.)
 *
 * `activeCatches` holds pending AND disputed catches (a disputed catch
 * still needs host resolution), recipient-filtered to the parties + the
 * host. Decided catches (confirmed / disputed) appear in
 * `decidedCatches` instead, so the after-tagged screen and auto-spectator
 * state survive a reload — a snapshot is the whole truth, and a decided
 * catch must be rebuildable from it, not only from live `catch.*` events.
 */
import type {
  CatchEvent,
  CatchView,
  LocationFix,
  Player,
  PlayerView,
  Room,
  WsSnapshotPayload,
} from '@pakdam/shared';
import { isPendingCatch, toCatchView } from './catch.js';

/**
 * One seat as a viewer sees it: hash stripped, and role/team kept only for
 * the viewer's own seat — every other seat's role is `null`.
 * `presence` (v29) is the seat's 30 s-rule presence/deadline when the
 * caller supplies it; omitted views carry no presence fields.
 */
export function playerViewFor(
  viewerPlayerId: string,
  player: Player,
  presence?: { reconnectEndsAtMs: number | null; presence: 'present' | 'away' },
): PlayerView {
  const { reconnectTokenHash: _hash, ...rest } = player;
  const base: PlayerView =
    player.playerId === viewerPlayerId
      ? rest
      : { ...rest, matchRole: null, team: null };
  if (presence === undefined) return base;
  return { ...base, presence: presence.presence, reconnectEndsAtMs: presence.reconnectEndsAtMs };
}

/** Every seat as this viewer sees it. */
export function playersViewFor(
  viewerPlayerId: string,
  players: readonly Player[],
  seatPresence?: Record<string, { reconnectEndsAtMs: number | null; presence: 'present' | 'away' }>,
): PlayerView[] {
  return players.map((p) => playerViewFor(viewerPlayerId, p, seatPresence?.[p.playerId]));
}

/**
 * Pending AND disputed catches this viewer may see: the parties to the
 * catch, plus the host. A disputed catch is still "active" from the
 * host's perspective — it needs resolution — so it must not vanish from
 * the host UI after a reload (it also still appears in
 * `decidedCatchesFor` below; the client merges the two lists). The
 * dispute state is currently unreachable via the UI (founder decision:
 * no dispute button), so this is defense-in-depth. Confirmed / rejected /
 * expired catches never appear here.
 */
export function activeCatchesFor(
  viewerPlayerId: string,
  viewerIsHost: boolean,
  catches: readonly CatchEvent[],
): CatchView[] {
  return catches
    .filter(
      (c) =>
        (isPendingCatch(c) || c.state === 'disputed') &&
        (viewerIsHost ||
          c.hunterPlayerId === viewerPlayerId ||
          c.runnerPlayerId === viewerPlayerId),
    )
    .map(toCatchView);
}

/**
 * Decided catches this viewer may see (confirmed or disputed): the parties
 * to the catch, plus the host. Same recipient filter as `activeCatchesFor`,
 * so role secrecy is unchanged — a seat only ever learns about catches it
 * took part in (or the host sees all). The client merges these into its
 * session catches on every snapshot, which is what restores the
 * after-tagged screen and auto-spectator state after a reload.
 */
export function decidedCatchesFor(
  viewerPlayerId: string,
  viewerIsHost: boolean,
  catches: readonly CatchEvent[],
): CatchView[] {
  return catches
    .filter(
      (c) =>
        (c.state === 'confirmed' || c.state === 'disputed') &&
        (viewerIsHost ||
          c.hunterPlayerId === viewerPlayerId ||
          c.runnerPlayerId === viewerPlayerId),
    )
    .map(toCatchView);
}

/**
 * The viewer's live teammate view: the teammate playerIds and their
 * latest fixes. Teammates only — never an opponent, never the viewer.
 * A caught Runner (still a Runner, with a confirmed catch against them)
 * gets an empty view: once tagged they lose the live teammate view
 * entirely. A viewer with no team gets an empty view. A teammate
 * without a fix is in `teammateIds` but not in `teammateFixes`.
 */
export function teammateViewFor(
  viewerPlayerId: string,
  players: readonly Player[],
  fixes: Readonly<Record<string, LocationFix | null>>,
  catches: readonly CatchEvent[],
): { teammateIds: string[]; teammateFixes: Record<string, LocationFix> } {
  const viewer = players.find((p) => p.playerId === viewerPlayerId);
  const team = viewer?.team ?? null;
  if (team === null) return { teammateIds: [], teammateFixes: {} };
  // Caught Runner (Classic): a confirmed catch against a viewer who is
  // still a Runner. Infection flips a tagged Runner to Hunter, so a
  // flipped player has team 'hunters' here and is unaffected.
  const isCaughtRunner =
    team === 'runners' &&
    catches.some(
      (c) => c.state === 'confirmed' && c.runnerPlayerId === viewerPlayerId,
    );
  if (isCaughtRunner) return { teammateIds: [], teammateFixes: {} };
  const teammateIds = players
    .filter(
      (p) =>
        p.playerId !== viewerPlayerId && p.team === team && p.leftAt === null,
    )
    .map((p) => p.playerId);
  const teammateFixes: Record<string, LocationFix> = {};
  for (const id of teammateIds) {
    const fix = fixes[id];
    if (fix !== undefined && fix !== null) teammateFixes[id] = fix;
  }
  return { teammateIds, teammateFixes };
}

/**
 * Build the authorised snapshot for one viewer. The caller supplies the
 * server-held state; this function applies the privacy rules and nothing
 * else. No opponent coordinates, no pending pings, no token hashes — ever.
 * (Teammates' coordinates ARE carried, in `teammateFixes` — see above.)
 */
export function buildSnapshot(input: {
  room: Room;
  players: readonly Player[];
  viewerPlayerId: string;
  viewerIsHost: boolean;
  serverSeq: number;
  locationStatus: Record<string, 'known' | 'unknown'>;
  catches: readonly CatchEvent[];
  safetyState: WsSnapshotPayload['safetyState'];
  missedAnnouncements: WsSnapshotPayload['missedAnnouncements'];
  /** Latest live fix per player (server-held, memory only). */
  fixes: Readonly<Record<string, LocationFix | null>>;
  /**
   * v24 — host reconnect grace deadline (epoch ms), or null when no
   * grace is running. Passed straight through to the payload.
   */
  hostGraceEndsAtMs: number | null;
  /**
   * v29 — per-seat 30 s-rule presence/deadline, keyed by playerId.
   * Optional: snapshots built without a store omit it and carry no
   * presence fields. The DO always supplies it (see
   * `RoomStore.seatPresenceMap`).
   */
  seatPresence?: Record<string, { reconnectEndsAtMs: number | null; presence: 'present' | 'away' }>;
  /**
   * v29 (R5 fix round) — the DO instance's memory epoch, epoch ms,
   * stamped when the DO loads/restores durable state (changes on
   * every wake). Carried top-level on the payload so the client can
   * include it in its snapshot key.
   */
  epochMs: number;
}): WsSnapshotPayload {
  const teammates = teammateViewFor(
    input.viewerPlayerId,
    input.players,
    input.fixes,
    input.catches,
  );
  // v29 (R1) — durable watermark for the client snapshot key
  // `version:serverSeq:maxLastFixAtMs:epochMs`: the newest `lastFixAt`
  // across the roster (null when nobody has reported). `lastFixAt` is
  // durable and persisted ≤ 30 s, so after a DO eviction the restored
  // watermark is ≤ the cached one and the key differs. The epoch
  // (memory only, stamped on load) covers the case the watermark
  // cannot: durable seq + watermark unchanged across a wake while
  // memory-only `teammateFixes` / `locationStatus` are gone.
  let maxLastFixAtMs: number | null = null;
  for (const p of input.players) {
    if (p.lastFixAt === null) continue;
    const ms = Date.parse(p.lastFixAt);
    if (!Number.isNaN(ms) && (maxLastFixAtMs === null || ms > maxLastFixAtMs)) {
      maxLastFixAtMs = ms;
    }
  }
  return {
    room: input.room,
    players: playersViewFor(input.viewerPlayerId, input.players, input.seatPresence),
    phase: input.room.phase,
    version: input.room.version,
    serverSeq: input.serverSeq,
    maxLastFixAtMs,
    epochMs: input.epochMs,
    locationStatus: input.locationStatus,
    activeCatches: activeCatchesFor(
      input.viewerPlayerId,
      input.viewerIsHost,
      input.catches,
    ),
    decidedCatches: decidedCatchesFor(
      input.viewerPlayerId,
      input.viewerIsHost,
      input.catches,
    ),
    teammateIds: teammates.teammateIds,
    teammateFixes: teammates.teammateFixes,
    safetyState: input.safetyState,
    missedAnnouncements: input.missedAnnouncements,
    // v24: null when no grace is running (older callers that omit
    // the field read as null, not undefined).
    hostGraceEndsAtMs: input.hostGraceEndsAtMs ?? null,
  };
}
