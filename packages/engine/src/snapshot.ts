/**
 * Pakdam engine — snapshot building with ROLE SECRECY.
 *
 * A snapshot is the whole truth the UI renders — and it NEVER carries raw
 * coordinates, pending pings, or token hashes. Pings arrive only as `ping`
 * events after connect; a reconnect loses earlier pings.
 *
 * Role secrecy: each player sees only their OWN role/team; every other
 * seat's role is `null` (the Hunter's catch picker shows names only;
 * caught/survivor lists come from `room.result` only). The reconnect-token
 * hash is stripped for every seat, including the viewer's own.
 *
 * `activeCatches` holds pending catches only, recipient-filtered to the
 * parties + the host. Decided catches (confirmed / disputed) appear in
 * `decidedCatches` instead, so the after-tagged screen and auto-spectator
 * state survive a reload — a snapshot is the whole truth, and a decided
 * catch must be rebuildable from it, not only from live `catch.*` events.
 */
import type {
  CatchEvent,
  CatchView,
  Player,
  PlayerView,
  Room,
  WsSnapshotPayload,
} from '@pakdam/shared';
import { isPendingCatch, toCatchView } from './catch.js';

/**
 * One seat as a viewer sees it: hash stripped, and role/team kept only for
 * the viewer's own seat — every other seat's role is `null`.
 */
export function playerViewFor(viewerPlayerId: string, player: Player): PlayerView {
  const { reconnectTokenHash: _hash, ...rest } = player;
  if (player.playerId === viewerPlayerId) return rest;
  return { ...rest, matchRole: null, team: null };
}

/** Every seat as this viewer sees it. */
export function playersViewFor(
  viewerPlayerId: string,
  players: readonly Player[],
): PlayerView[] {
  return players.map((p) => playerViewFor(viewerPlayerId, p));
}

/**
 * Pending catches this viewer may see: the parties to the catch, plus the
 * host. Confirmed/disputed/rejected/expired catches never appear.
 */
export function activeCatchesFor(
  viewerPlayerId: string,
  viewerIsHost: boolean,
  catches: readonly CatchEvent[],
): CatchView[] {
  return catches
    .filter(
      (c) =>
        isPendingCatch(c) &&
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
 * Build the authorised snapshot for one viewer. The caller supplies the
 * server-held state; this function applies the privacy rules and nothing
 * else. No coordinates, no pending pings, no token hashes — ever.
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
}): WsSnapshotPayload {
  return {
    room: input.room,
    players: playersViewFor(input.viewerPlayerId, input.players),
    phase: input.room.phase,
    version: input.room.version,
    serverSeq: input.serverSeq,
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
    safetyState: input.safetyState,
    missedAnnouncements: input.missedAnnouncements,
  };
}
